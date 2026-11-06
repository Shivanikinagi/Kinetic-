import "../src/env.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { formatEther, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadJob } from "../src/agent/report.js";
import { loadNetworkConfig } from "../src/config.js";
import { splitIntoChunks } from "../src/core/chunker.js";
import { attestable, serviceKind, zeroGBroker, zeroGDirectory, type ZeroGService } from "../src/integrations/zerog-compute.js";
import { buildMessages } from "../src/tasks/prompt.js";
import { loadRoleEnv, roleEnvPath, ROLES } from "../src/testnet/roles.js";

// 0G Compute for KINETIC providers that call one 0G provider directly (PROVIDER_BACKEND=0g-compute).
//
//   npm run zerog -- providers   chatbot services on the 0G chain and whether they can be attested (read-only)
//   npm run zerog -- assign      proposes a 0G provider for each model-running role; --yes writes it to their .env files
//   npm run zerog -- plan        pre-flight for a live job: assignments, wallet, funding, expected cost (read-only)
//   npm run zerog -- fund        prints the transactions it would send; add --yes to send them
//   npm run zerog -- status      the paying wallet, its compute ledger and sub-accounts (read-only)
//
// The paying wallet is ZG_PRIVATE_KEY from .env, shared by every provider role.

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    yes: { type: "boolean", default: false },
    // assign: only the attestable 0G providers (fewer sub-accounts to fund); and which provider simulates a 0G outage.
    "only-attestable": { type: "boolean", default: false },
    "zg-failure": { type: "string" },
    // plan: the live job's size (npm run live defaults).
    items: { type: "string", default: "36" },
    chunk: { type: "string", default: "3" },
    task: { type: "string", default: "data/classify-tickets.task.json" },
  },
});
const command = positionals[0] ?? "providers";
const cfg = loadNetworkConfig();
const rpc = cfg.zgCompute.rpcUrl;

// The SDK keeps each provider sub-account at 2 × its 1 0G minimum: it tops up before a request
// whenever the balance is lower (checkAndFund(provider, 2)). A ledger needs 3 0G to be created.
const SUB_ACCOUNT = parseEther("2");
const LEDGER_MIN = parseEther("3");

const chatbots = async () => (await zeroGDirectory(cfg).list()).filter((s) => s.serviceType === "chatbot");
const modelRoles = () => ROLES.filter((r) => r.provider && r.provider.behavior !== "lazy");
const og = (n: bigint) => `${Number(formatEther(n)).toFixed(6).replace(/\.?0+$/, "")} 0G`;

/** Best first: a 0G node with checkable attestation, then an attested relay to an outside cloud, then the rest. */
function tier(s: ZeroGService): 0 | 1 | 2 {
  if (!attestable(s)) return 2;
  return serviceKind(s).providerType === "decentralized" ? 0 : 1;
}
function describe(s: ZeroGService): string {
  const kind = serviceKind(s);
  const where = kind.providerType === "centralized" ? `TEE relay to ${kind.providerIdentity ?? "an outside cloud"}, not a 0G node` : "runs on a 0G node";
  const att = attestable(s) ? "attestation checkable" : `attestation unavailable (${!s.verifiability ? "no verifiability" : !s.teeSignerAcknowledged ? "TEE signer not acknowledged" : "no signer"})`;
  return `${s.model} · ${where} · ${att}`;
}

function setEnv(path: string, entries: Record<string, string>) {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(entries)) {
    const i = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (i >= 0) lines[i] = `${key}=${value}`;
    else lines.splice(lines.at(-1) === "" ? lines.length - 1 : lines.length, 0, `${key}=${value}`);
  }
  writeFileSync(path, lines.join("\n"));
}

function payingKey(): string | undefined {
  const key = process.env.ZG_PRIVATE_KEY;
  return key && /^0x[0-9a-fA-F]{64}$/.test(key) ? key : undefined;
}

function assigned(): { role: string; name: string; behavior: string; zgProvider: string }[] {
  return modelRoles()
    .map((r) => ({ role: r.role, name: r.provider!.name, env: loadRoleEnv(r.role) }))
    .filter((r) => r.env.PROVIDER_BACKEND === "0g-compute" && r.env.ZG_PROVIDER_ADDRESS)
    .map((r) => ({ role: r.role, name: r.name, behavior: r.env.PROVIDER_BEHAVIOR || "honest", zgProvider: r.env.ZG_PROVIDER_ADDRESS!.toLowerCase() }));
}

/**
 * The assignment `assign` proposes: best 0G providers to the honest roles first, and each role a
 * different 0G provider while there are enough, so a reroute always has an independent one.
 */
async function proposal(): Promise<{ role: string; name: string; behavior: string; zgProvider: string; service: ZeroGService }[]> {
  const list = (await chatbots()).filter((s) => !values["only-attestable"] || attestable(s)).sort((a, b) => tier(a) - tier(b));
  if (list.length === 0) throw new Error(`no ${values["only-attestable"] ? "attestable " : ""}chatbot services on ${rpc}`);
  const roles = modelRoles().sort((a, b) => Number(a.provider!.behavior !== "honest") - Number(b.provider!.behavior !== "honest"));
  if (list.length < roles.length) console.log(`${list.length} 0G chatbot services for ${roles.length} providers: some share one (a shared one fails for all of them)`);
  return roles.map((r, i) => {
    const s = list[i % list.length];
    const behavior = values["zg-failure"] === r.provider!.name ? "zg-down-after:2" : r.provider!.behavior;
    return { role: r.role, name: r.provider!.name, behavior, zgProvider: s.provider, service: s };
  });
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

/** The deposit, transfers and gas a funding run needs for these 0G providers, given what is already funded. */
async function fundingNeeds(key: string | undefined, zgProviders: string[]) {
  let ledgerAvailable = 0n;
  let ledgerExists = false;
  const funded = new Map<string, bigint>();
  if (key) {
    const broker = await zeroGBroker(rpc, key);
    try {
      const ledger = await broker.ledger.getLedger();
      ledgerExists = true;
      ledgerAvailable = ledger.availableBalance;
    } catch {
      // No ledger yet.
    }
    for (const [p, bal] of await broker.ledger.getProvidersWithBalance("inference").catch(() => [] as [string, bigint, bigint][])) funded.set(p.toLowerCase(), bal);
  }
  const transfers = zgProviders.map((p) => ({ zgProvider: p, amount: (funded.get(p) ?? 0n) >= SUB_ACCOUNT ? 0n : SUB_ACCOUNT - (funded.get(p) ?? 0n) })).filter((t) => t.amount > 0n);
  const toTransfer = transfers.reduce((a, t) => a + t.amount, 0n);
  // The ledger must hold what the transfers move, and at least the creation minimum.
  const want = toTransfer > LEDGER_MIN || ledgerExists ? toTransfer : LEDGER_MIN;
  const deposit = want > ledgerAvailable ? want - ledgerAvailable : 0n;
  return { ledgerExists, ledgerAvailable, funded, transfers, deposit, txs: (deposit > 0n ? 1 : 0) + transfers.length };
}

if (command === "providers") {
  const list = (await chatbots()).sort((a, b) => tier(a) - tier(b));
  console.log(`\n${list.length} chatbot services on ${rpc}\n`);
  for (const s of list) console.log(`  ${["✓", "~", "·"][tier(s)]} ${s.provider}  ${describe(s)}`);
  console.log("\n✓ 0G node, attestation checkable   ~ attested relay to an outside cloud   · attestation unavailable");
} else if (command === "assign") {
  const roles = await proposal();
  for (const r of roles) {
    const entries: Record<string, string> = { PROVIDER_BACKEND: "0g-compute", ZG_PROVIDER_ADDRESS: r.zgProvider, PROVIDER_GPU: `0G Compute ${serviceKind(r.service).providerType} ${r.zgProvider.slice(0, 10)}` };
    if (r.behavior.startsWith("zg-down-after")) entries.PROVIDER_BEHAVIOR = r.behavior;
    if (values.yes) setEnv(roleEnvPath(r.role), entries);
    console.log(`  ${r.name.padEnd(8)} ${r.behavior.padEnd(16)} → ${r.zgProvider}  ${describe(r.service)}`);
  }
  console.log(values.yes ? "\nWrote PROVIDER_BACKEND=0g-compute and ZG_PROVIDER_ADDRESS to the role files in .kinetic/testnet/." : "\nProposed only: nothing written. Add --yes to write it to the role files in .kinetic/testnet/.");
  if (values["zg-failure"]) console.log(`${values["zg-failure"]} simulates its 0G provider going down after 2 chunks (labelled adversarial in its offer).`);
  console.log("Next: npm run zerog -- plan (same flags, to price this proposal before writing it)");
} else if (command === "plan") {
  // Read-only: nothing here sends a transaction or writes a file.
  const key = payingKey();
  const services = new Map((await chatbots()).map((s) => [s.provider, s]));
  const written = assigned();
  // With no roles assigned yet, price the proposal assign would write (same flags).
  const roles = written.length > 0 ? written : await proposal();
  const problems: string[] = [];
  const notes: string[] = [];

  console.log(`\n1. Provider assignments${written.length > 0 ? "" : " (PROPOSED: not written yet; npm run zerog -- assign --yes with the same flags writes it)"}`);
  if (written.length === 0) problems.push("the assignment is not written yet: npm run zerog -- assign --yes");
  for (const r of roles) {
    const s = services.get(r.zgProvider);
    console.log(`  ${r.name.padEnd(8)} ${r.behavior.padEnd(16)} → ${r.zgProvider}  ${s ? describe(s) : "NOT REGISTERED"}`);
    if (!s) problems.push(`${r.name}: ${r.zgProvider} is not a chatbot service on the 0G chain`);
  }
  const upstreams = [...new Set(roles.map((r) => r.zgProvider))];
  const attestedUpstreams = upstreams.filter((p) => services.get(p) && attestable(services.get(p)!));
  const nodes = attestedUpstreams.filter((p) => serviceKind(services.get(p)!).providerType === "decentralized");
  console.log(`  ${upstreams.length} distinct 0G providers; ${attestedUpstreams.length} with checkable attestation, ${nodes.length} of them a 0G node`);
  if (attestedUpstreams.length < 2) notes.push("fewer than 2 attestable 0G providers: a chunk rerouted away from one may land on an unattested one");
  if (!roles.some((r) => r.behavior.startsWith("zg-down-after"))) notes.push("no provider simulates a 0G outage, so a 0G-level reroute will happen only if a real 0G provider fails (assign --zg-failure <name>)");
  for (const p of upstreams.filter((p) => !attestedUpstreams.includes(p))) notes.push(`chunks on ${p} will be recorded as attestation "unavailable", never as verified`);
  const relays = attestedUpstreams.filter((p) => serviceKind(services.get(p)!).providerType === "centralized");
  for (const p of relays) notes.push(`${p} is a TEE relay to ${serviceKind(services.get(p)!).providerIdentity ?? "an outside cloud"}: attested routing, but no 0G GPU runs the model`);

  console.log("\n2. Paying wallet");
  let balance = 0n;
  if (!key) problems.push("ZG_PRIVATE_KEY is not set in .env (a 0G testnet wallet, 0x + 64 hex)");
  else {
    const address = privateKeyToAccount(key as Hex).address;
    balance = BigInt(await rpcCall<string>("eth_getBalance", [address, "latest"]));
    console.log(`  ${address}: ${og(balance)}`);
  }

  console.log("\n3. Funding (moved into 0G's contracts, not spent)");
  const needs = await fundingNeeds(key, upstreams);
  console.log(`  compute ledger: ${needs.ledgerExists ? `${og(needs.ledgerAvailable)} available` : "not created yet (needs at least 3 0G)"}`);
  for (const p of upstreams) console.log(`  sub-account ${p}: ${og(needs.funded.get(p) ?? 0n)} of the 2 0G the SDK keeps there`);
  console.log(`  deposit into the ledger: ${og(needs.deposit)}`);
  for (const t of needs.transfers) console.log(`  transfer to ${t.zgProvider}: ${og(t.amount)}`);

  console.log("\n4. Expected cost of the job (actually spent)");
  const { task, items } = loadJob(values.task!, "data/tickets.jsonl");
  const parts = splitIntoChunks(items.slice(0, Number(values.items)), Number(values.chunk));
  const avgPrompt = Math.ceil(parts.reduce((a, c) => a + JSON.stringify(buildMessages(task, c)).length, 0) / parts.length / 3.5);
  const avgCompletion = Number(values.chunk) * 40;
  // Every chunk, a quarter more for reroutes, and up to two admission probes per provider.
  const chats = Math.ceil(parts.length * 1.25) + roles.length * 2;
  const priciest = upstreams.map((p) => services.get(p)).filter((s): s is ZeroGService => !!s).reduce((max, s) => {
    const c = BigInt(avgPrompt) * (s.inputPrice ?? 0n) + BigInt(avgCompletion) * (s.outputPrice ?? 0n);
    return c > max ? c : max;
  }, 0n);
  const inference = BigInt(chats) * priciest;
  const gasPrice = BigInt(await rpcCall<string>("eth_gasPrice", []));
  const gas = BigInt(needs.txs + 2) * 300_000n * gasPrice;
  console.log(`  ${parts.length} chunks of ${values.chunk} items; up to ${chats} 0G chats at ~${avgPrompt} prompt + ~${avgCompletion} completion tokens`);
  console.log(`  inference, upper bound (every chat at the priciest assigned provider): ${og(inference)}`);
  console.log(`  gas for ${needs.txs} funding tx(s) plus a margin, at ${formatEther(gasPrice * 1_000_000_000n)} gwei: ~${og(gas)}`);
  console.log("  The verifier's canary reference runs go through the 0G router on ZEROG_API_KEY credits, not this wallet.");
  console.log("  Hedera side (bonds, x402 payments, HCS): as for any live run; npm run doctor checks it.");

  const needed = needs.deposit + gas;
  console.log(`\n5. Needed in the wallet now: ${og(needed)} (has ${og(balance)})`);
  console.log(`   Of that, ${og(inference)} at most is spent on inference; the rest stays in the ledger and`);
  console.log("   sub-accounts and can be retrieved (retrieveFund, then refund) after 0G's lock period.");
  if (key && balance < needed) problems.push(`the wallet needs ${og(needed - balance)} more`);
  if (!cfg.zerog.apiKey) problems.push("ZEROG_API_KEY is not set: the verifier's canary reference runs need it");

  for (const n of notes) console.log(`  note: ${n}`);
  if (problems.length) {
    console.log("\nNOT READY:");
    for (const p of problems) console.log(`  ✗ ${p}`);
    process.exitCode = 1;
  } else console.log("\nREADY: npm run zerog -- fund (prints the transactions), then fund --yes, then npm run live");
} else if (command === "fund") {
  const key = payingKey();
  if (!key) throw new Error("set ZG_PRIVATE_KEY in .env: a 0G testnet wallet that pays for compute (0x + 64 hex)");
  const upstreams = [...new Set(assigned().map((r) => r.zgProvider))];
  if (upstreams.length === 0) throw new Error("no provider roles assigned yet: npm run zerog -- assign");
  const needs = await fundingNeeds(key, upstreams);
  if (needs.txs === 0) {
    console.log("already funded: nothing to send");
  } else {
    console.log(values.yes ? "sending:" : "would send (dry run; add --yes to send):");
    if (needs.deposit > 0n) console.log(`  deposit ${og(needs.deposit)} into the compute ledger`);
    for (const t of needs.transfers) console.log(`  transfer ${og(t.amount)} to the sub-account for ${t.zgProvider}`);
    if (values.yes) {
      const broker = await zeroGBroker(rpc, key);
      if (needs.deposit > 0n) await broker.ledger.depositFund(Number(formatEther(needs.deposit)));
      for (const t of needs.transfers) await broker.ledger.transferFund(t.zgProvider, "inference", t.amount);
      console.log("done: npm run zerog -- status");
    }
  }
} else if (command === "status") {
  const key = payingKey();
  if (!key) throw new Error("set ZG_PRIVATE_KEY in .env");
  const address = privateKeyToAccount(key as Hex).address;
  console.log(`\npaying wallet ${address}: ${og(BigInt(await rpcCall<string>("eth_getBalance", [address, "latest"])))} on ${rpc}`);
  const needs = await fundingNeeds(key, [...new Set(assigned().map((r) => r.zgProvider))]);
  console.log(`compute ledger: ${needs.ledgerExists ? `${og(needs.ledgerAvailable)} available` : "none yet"}`);
  for (const r of assigned()) console.log(`  ${r.name.padEnd(8)} → ${r.zgProvider}: ${og(needs.funded.get(r.zgProvider) ?? 0n)} in its sub-account`);
} else {
  throw new Error(`unknown command ${command}: providers, assign, plan, fund or status`);
}
