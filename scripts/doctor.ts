import "../src/env.js";
import { arkivChain } from "../src/integrations/arkiv.js";
import { createPublicClient, formatEther, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";
import { loadNetworkConfig } from "../src/config.js";
import { ArkivSdkStore } from "../src/integrations/arkiv.js";
import { VAULT_ABI } from "../src/integrations/vault.js";
import { swarmClient } from "../src/integrations/index.js";
import { loadRoleEnv, ROLES } from "../src/testnet/roles.js";

// Read-only preflight against the live networks for every role in .kinetic/testnet/.
// Writes nothing and spends nothing.

let failures = 0;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const bad = (msg: string) => (failures++, console.log(`  ✗ ${msg}`));
const check = async (label: string, fn: () => Promise<string>) => {
  try {
    ok(`${label}: ${await fn()}`);
  } catch (err) {
    bad(`${label}: ${(err as Error).message}`);
  }
};
const getJson = async (url: string, init?: RequestInit) => {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} from ${url}`);
  return res.json() as Promise<any>;
};

const verifierEnv = loadRoleEnv("verifier");
const cfg = loadNetworkConfig(verifierEnv);
const verifierAddress = privateKeyToAccount(verifierEnv.KINETIC_PRIVATE_KEY as Hex).address.toLowerCase();
const evm = createPublicClient({ chain: hederaTestnet, transport: http(cfg.hedera.jsonRpcUrl) });
const arkiv = createPublicClient({ chain: arkivChain(cfg.arkiv), transport: http(cfg.arkiv.rpcUrl, cfg.arkiv.apiKey ? { fetchOptions: { headers: { "X-API-KEY": cfg.arkiv.apiKey } } } : {}) });

console.log("\nShared");
// Quotes fail over down this list, so each one is checked; one answering is enough to take payments.
for (const url of cfg.x402.facilitatorUrls) {
  await check(`x402 facilitator ${new URL(url).host}`, async () => {
    const s = await getJson(`${url}/supported`);
    const kind = s.kinds.find((k: any) => k.scheme === "exact" && k.network === cfg.x402.network);
    if (!kind) throw new Error(`does not support exact on ${cfg.x402.network}`);
    return `${cfg.x402.network} feePayer ${kind.extra?.feePayer}`;
  });
}
await check("HCS topic", async () => {
  const t = await getJson(`${cfg.hedera.mirrorUrl}/api/v1/topics/${cfg.hedera.hcsTopicId}`);
  return `${cfg.hedera.hcsTopicId} submit key ${t.submit_key?._type ?? "none"}`;
});
await check("bond vault", async () => {
  const address = cfg.hedera.vaultAddress!;
  const code = await evm.getCode({ address });
  if (!code || code === "0x") throw new Error(`no contract at ${address}`);
  let verifiers: string[];
  try {
    verifiers = (await evm.readContract({ address, abi: VAULT_ABI, functionName: "verifiers" })).map((v) => v.toLowerCase());
  } catch {
    throw new Error(`${address} is the old single-arbiter vault; re-run npm run setup:testnet to deploy the quorum vault`);
  }
  const read = <T>(functionName: string) => evm.readContract({ address, abi: VAULT_ABI, functionName } as never) as Promise<T>;
  const [threshold, disputeThreshold, window] = await Promise.all([read<number>("threshold"), read<number>("disputeThreshold"), read<bigint>("disputeWindow")]);
  if (!verifiers.includes(verifierAddress)) throw new Error(`the verifier ${verifierAddress} is not one of the vault's verifiers`);
  for (const r of ROLES.filter((x) => x.cosigner)) {
    const a = privateKeyToAccount(loadRoleEnv(r.role).KINETIC_PRIVATE_KEY as Hex).address.toLowerCase();
    if (!verifiers.includes(a)) throw new Error(`${r.role} ${a} is not one of the vault's verifiers`);
  }
  const cosigners = cfg.quorum.cosigners.length;
  if (cosigners + 1 < threshold) throw new Error(`the verifier knows ${cosigners} cosigner(s) (VERIFIER_COSIGNERS) but slashing needs ${threshold} signatures`);
  // HIP-1215: a vault from before scheduled finalization leaves every slash to the settle loop.
  const selfExecuting = await read<bigint>("SCHEDULE_GAS_LIMIT").then(
    () => "executes its own slashes (HIP-1215)",
    () => "deployed before HIP-1215 scheduling: redeploy to have slashes execute themselves",
  );
  return `${address}: ${threshold} of ${verifiers.length} verifiers to slash, ${disputeThreshold} to decide a dispute, ${window}s dispute window; ${selfExecuting}`;
});
await check("Swarm", async () => {
  const res = await fetch(`${cfg.swarm.beeUrl}/health`);
  if (!res.ok) throw new Error(`${cfg.swarm.beeUrl} answered ${res.status}`);
  // The public gateway keeps uploads only for a while; a Compute Passport there can expire.
  const paid = cfg.swarm.postageBatchId && (cfg.swarm.stampKey ? `, postage batch ${cfg.swarm.postageBatchId.slice(0, 8)}… stamped client-side` : /gateway\.ethswarm\.org/.test(cfg.swarm.beeUrl) ? ", BEE_POSTAGE_BATCH_ID set but the public gateway ignores it without SWARM_STAMP_KEY (docs/SWARM_STAMP.md)" : ", postage batch set");
  // With our own stamps, one tiny stamped upload shows the gateway takes them (it uses one slot).
  if (cfg.swarm.stampKey) await swarmClient(cfg).upload(new TextEncoder().encode(`kinetic doctor ${new Date().toISOString()}`));
  return `${cfg.swarm.beeUrl} healthy${paid || " (public gateway, no postage batch: passports may expire; see docs/SWARM_STAMP.md)"}`;
});
await check("0G model", async () => {
  const models = await getJson(`${cfg.zerog.baseUrl}/models`);
  const m = models.data.find((x: any) => x.id === cfg.zerog.model);
  if (!m) throw new Error(`${cfg.zerog.model} not offered by the router`);
  if (!m.verifiability) throw new Error(`${cfg.zerog.model} has no verified tier; pick a model with verifiability set`);
  return `${m.id} (${m.verifiability}, ${m.tee_type ?? "TEE"})`;
});
await check("0G key", async () => {
  if (!cfg.zerog.apiKey) throw new Error("ZEROG_API_KEY not set for the verifier");
  const auth = { authorization: `Bearer ${cfg.zerog.apiKey}` };
  const balance = await fetch(`${cfg.zerog.baseUrl}/account/balance`, { headers: auth });
  if (balance.ok) return `balance ${JSON.stringify(await balance.json()).slice(0, 100)}`;
  // Inference-only keys can't read the balance; prove the key works with one tiny call instead.
  const res = await fetch(`${cfg.zerog.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json", "x-0g-provider-trust-mode": cfg.zerog.trustMode },
    body: JSON.stringify({ model: cfg.zerog.model, messages: [{ role: "user", content: "Reply ok." }], max_tokens: 4 }),
  });
  if (!res.ok) throw new Error(`inference failed (${res.status}): ${(await res.text()).slice(0, 160)}`);
  const body = (await res.json()) as { x_0g_trace?: { request_id?: string } };
  return `inference works (balance not readable with this key), request ${body.x_0g_trace?.request_id}`;
});

for (const r of ROLES) {
  console.log(`\n${r.role}`);
  const env = loadRoleEnv(r.role);
  const account = privateKeyToAccount(env.KINETIC_PRIVATE_KEY as Hex);
  const address = account.address.toLowerCase();
  if (r.cosigner) {
    // A cosigner needs no Hedera account or Arkiv gas: it reads, re-runs canaries on 0G and signs.
    await check("cosigner", async () => {
      if (!env.ZEROG_API_KEY) throw new Error("ZEROG_API_KEY not set: a cosigner re-runs failed canaries on 0G");
      const url = cfg.quorum.cosigners.find((u) => u.endsWith(`:${r.cosigner!.port}`));
      if (!url) throw new Error(`the verifier's VERIFIER_COSIGNERS doesn't list port ${r.cosigner!.port}`);
      return `${address} on ${url}`;
    });
    continue;
  }
  await check("Hedera account", async () => {
    const a = await getJson(`${cfg.hedera.mirrorUrl}/api/v1/accounts/${env.HEDERA_ACCOUNT_ID}`);
    if (a.evm_address?.toLowerCase() !== address) throw new Error(`EVM alias ${a.evm_address} does not match key address ${address}`);
    const hbar = Number(a.balance.balance) / 1e8;
    if (hbar < 1) throw new Error(`${env.HEDERA_ACCOUNT_ID} only has ${hbar} ℏ`);
    return `${env.HEDERA_ACCOUNT_ID} ${hbar} ℏ, alias ${address}`;
  });
  await check("Arkiv gas", async () => {
    const balance = await arkiv.getBalance({ address: address as Hex });
    // About 0.0003 per write; the buyer makes the most writes.
    const need = r.role === "buyer" ? 50_000_000_000_000_000n : 10_000_000_000_000_000n;
    if (balance < need) throw new Error(`${address} has ${formatEther(balance)} Arkiv gas, below ${formatEther(need)} (re-run npm run setup:testnet)`);
    return formatEther(balance);
  });
  if (r.role === "buyer") {
    await check("Arkiv read", async () => `${(await new ArkivSdkStore(account, cfg.arkiv).query("offer")).length} KINETIC offers visible`);
  }
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed. Run: npm run live");
process.exit(failures ? 1 : 0);
