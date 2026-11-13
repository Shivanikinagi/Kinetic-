import "../src/env.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { AccountCreateTransaction, AccountId, Client, Hbar, PrivateKey, TopicCreateTransaction } from "@hiero-ledger/sdk";
import { arkivChain } from "../src/integrations/arkiv.js";
import { createPublicClient, createWalletClient, formatEther, http, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadNetworkConfig } from "../src/config.js";
import { deployVault, vaultRulesFromEnv } from "../src/integrations/vault-deploy.js";
import { DEFAULT_0G_WORKER_MODEL } from "../src/provider/backend.js";
import { loadState, roleEnvPath, ROLES, saveState, TESTNET_DIR } from "../src/testnet/roles.js";

// One-shot testnet bootstrap. From ONE funded Hedera testnet account and ONE funded Arkiv
// wallet it creates every role's account, the HCS topic, the bond vault, and an env file
// per role in .kinetic/testnet/. Safe to re-run: finished steps are skipped.
//
//   OPERATOR_ID=0.0.x OPERATOR_KEY=<portal key> [ARKIV_FUNDER_KEY=0x…] ZEROG_API_KEY=… npm run setup:testnet

const env = process.env;
const need = (name: string) => {
  const v = env[name];
  if (!v) throw new Error(`${name} is required. See README → Running on testnets.`);
  return v;
};

function parseOperatorKey(raw: string): PrivateKey {
  if (raw.startsWith("0x")) return PrivateKey.fromStringECDSA(raw.slice(2));
  try {
    return PrivateKey.fromStringDer(raw);
  } catch {
    return PrivateKey.fromStringECDSA(raw);
  }
}

const cfg = loadNetworkConfig({ ...env, KINETIC_NETWORK: "testnet", BOND_VAULT_ADDRESS: "0x0000000000000000000000000000000000000000" });
const operatorId = AccountId.fromString(need("OPERATOR_ID"));
const operatorKey = parseOperatorKey(need("OPERATOR_KEY"));
const operator = Client.forTestnet().setOperator(operatorId, operatorKey);
const state = loadState();
const step = (msg: string) => console.log(`\n▸ ${msg}`);

// --rotate <role> (repeatable): give a role a brand-new key and account, e.g. a provider that
// was slashed (slashing is permanent per address) so it can be slashed again in a new run.
const { values: flags } = parseArgs({ options: { rotate: { type: "string", multiple: true, default: [] } } });
for (const role of flags.rotate ?? []) {
  if (role === "verifier" || ROLES.some((r) => r.role === role && r.cosigner)) throw new Error(`rotating ${role} would orphan the HCS topic or the vault's verifier set; re-create them instead`);
  if (!ROLES.some((r) => r.role === role)) throw new Error(`unknown role ${role}`);
  delete state.keys[role];
  delete state.accounts[role];
  delete state.addresses[role];
  delete state.arkivFunded[role];
  console.log(`rotating ${role}: a new key and account will be created`);
}

// 1. Keys and Hedera accounts (ECDSA with EVM alias, so one key works on HCS, x402 and the EVM).
step("Hedera accounts");
for (const r of ROLES) {
  state.keys[r.role] ??= generatePrivateKey();
  state.addresses[r.role] = privateKeyToAccount(state.keys[r.role]).address.toLowerCase();
  if (r.cosigner) {
    console.log(`  ${r.role.padEnd(11)} no account needed (cosigner) · ${state.addresses[r.role]}`);
    continue;
  }
  if (state.accounts[r.role]) {
    console.log(`  ${r.role.padEnd(11)} ${state.accounts[r.role]} (exists)`);
    continue;
  }
  const key = PrivateKey.fromStringECDSA(state.keys[r.role].slice(2));
  const response = await new AccountCreateTransaction().setECDSAKeyWithAlias(key).setInitialBalance(new Hbar(r.hbar)).execute(operator);
  const receipt = await response.getReceipt(operator);
  state.accounts[r.role] = receipt.accountId!.toString();
  saveState(state);
  console.log(`  ${r.role.padEnd(11)} ${state.accounts[r.role]} funded ${r.hbar} ℏ · ${state.addresses[r.role]}`);
}

const verifierKey = PrivateKey.fromStringECDSA(state.keys.verifier.slice(2));
const verifierClient = Client.forTestnet().setOperator(AccountId.fromString(state.accounts.verifier), verifierKey);

// 2. HCS topic, created and owned by the verifier, with the verifier as the only submitter.
step("HCS receipts topic");
if (!state.hcsTopicId) {
  const response = await new TopicCreateTransaction()
    .setTopicMemo("KINETIC audit receipts")
    .setAdminKey(verifierKey.publicKey)
    .setSubmitKey(verifierKey.publicKey)
    .execute(verifierClient);
  state.hcsTopicId = (await response.getReceipt(verifierClient)).topicId!.toString();
  saveState(state);
}
console.log(`  topic ${state.hcsTopicId}  https://hashscan.io/testnet/topic/${state.hcsTopicId}`);

// 3. Bond vault, deployed by the verifier. Its verifiers are the verifier and the cosigners:
//    2 of the 3 sign a slash, all 3 decide a dispute. An older vault is replaced (providers
//    bonded there can still request their bond back from it): version 1 had a single arbiter,
//    version 2 couldn't execute its own slashes (HIP-1215) or draw PRNG seeds (HIP-351), and
//    version 3 scheduled them for the closing second, which Hedera's block time can still read as early.
step("KineticBondVault");
const VAULT_VERSION = 4;
if (state.vault && state.vault.version !== VAULT_VERSION) {
  console.log(`  replacing the older vault ${state.vault.address} (version ${state.vault.version ?? 1}; bonds there: npm run bonds)`);
  state.retiredVaults = [...(state.retiredVaults ?? []), state.vault];
  state.vault = undefined;
}
if (!state.vault) {
  const verifierAccount = privateKeyToAccount(state.keys.verifier);
  const verifiers = ROLES.filter((r) => r.role === "verifier" || r.cosigner).map((r) => privateKeyToAccount(state.keys[r.role]).address);
  const rules = vaultRulesFromEnv(env, verifiers);
  state.vault = { ...(await deployVault(verifierAccount, cfg.hedera.jsonRpcUrl, rules)), version: VAULT_VERSION };
  saveState(state);
  console.log(`  ${rules.threshold} of ${verifiers.length} verifiers to slash, ${rules.disputeThreshold} to decide a dispute, ${rules.disputeWindowSeconds}s dispute window`);
}
console.log(`  vault ${state.vault.address}  https://hashscan.io/testnet/contract/${state.vault.address}`);

// 4. Arkiv gas for every role that writes entities.
step("Arkiv gas");
const rawFunder = env.ARKIV_FUNDER_KEY || (env.OPERATOR_KEY!.startsWith("0x") ? env.OPERATOR_KEY : undefined);
// Accept a private key with or without the 0x prefix.
const funderKey = (rawFunder && /^[0-9a-fA-F]{64}$/.test(rawFunder) ? `0x${rawFunder}` : rawFunder) as Hex | undefined;
// The buyer writes the most (jobs, chunks, claims, patches), about 0.0003 per transaction.
const perRole = parseEther(env.ARKIV_FUND_PER_ROLE || "0.05");
const forRole = (role: string) => (role === "buyer" ? perRole * 6n : perRole);
const arkivNet = arkivChain(cfg.arkiv);
const arkivHttp = () => http(cfg.arkiv.rpcUrl, cfg.arkiv.apiKey ? { fetchOptions: { headers: { "X-API-KEY": cfg.arkiv.apiKey } } } : {});
const arkivReader = createPublicClient({ chain: arkivNet, transport: arkivHttp() });
const funderBalance = funderKey && /^0x[0-9a-fA-F]{64}$/.test(funderKey) ? await arkivReader.getBalance({ address: privateKeyToAccount(funderKey).address }) : 0n;
if (!funderKey || !/^0x[0-9a-fA-F]{64}$/.test(funderKey)) {
  console.log(
    /^0x[0-9a-fA-F]{40}$/.test(funderKey ?? "")
      ? "  skipped: ARKIV_FUNDER_KEY holds an address. It must be the wallet's 0x private key (64 hex digits)."
      : "  skipped: set ARKIV_FUNDER_KEY to the private key of a wallet funded at https://hub.arkiv.network/faucet",
  );
} else if (funderBalance === 0n) {
  console.log(`  skipped: funder ${privateKeyToAccount(funderKey).address} has no Arkiv gas yet (https://hub.arkiv.network/faucet)`);
} else {
  const funder = privateKeyToAccount(funderKey);
  const wallet = createWalletClient({ account: funder, chain: arkivNet, transport: arkivHttp() });
  console.log(`  funder ${funder.address} has ${formatEther(funderBalance)}`);
  for (const r of ROLES.filter((x) => !x.cosigner && !x.noArkiv)) {
    const address = state.addresses[r.role] as Hex;
    const balance = await arkivReader.getBalance({ address });
    if (balance >= forRole(r.role) / 2n) {
      console.log(`  ${r.role.padEnd(11)} ${formatEther(balance)} (enough)`);
      continue;
    }
    const hash = await wallet.sendTransaction({ to: address, value: forRole(r.role) });
    await arkivReader.waitForTransactionReceipt({ hash });
    state.arkivFunded[r.role] = hash;
    saveState(state);
    console.log(`  ${r.role.padEnd(11)} +${formatEther(forRole(r.role))} (${hash})`);
  }
}

// 4b. 0G gas for ERC-8004 (0G Chain): every provider registers itself as an agent (about
// 0.006 0G with its card); the verifier also posts reputation feedback after every job.
step("0G gas (ERC-8004 agents)");
if (!cfg.erc8004.enabled || !funderKey || !/^0x[0-9a-fA-F]{64}$/.test(funderKey)) {
  console.log("  skipped: ERC-8004 is off, or no funder key (the ARKIV_FUNDER_KEY wallet also pays 0G gas)");
} else {
  const zgChain = { id: cfg.erc8004.chainId, name: "0G Galileo", nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 }, rpcUrls: { default: { http: [cfg.erc8004.rpcUrl] } } };
  const zgReader = createPublicClient({ chain: zgChain, transport: http(cfg.erc8004.rpcUrl) });
  const zgWallet = createWalletClient({ account: privateKeyToAccount(funderKey), chain: zgChain, transport: http(cfg.erc8004.rpcUrl) });
  const need = (role: string) => parseEther(role === "verifier" ? env.ZG_GAS_VERIFIER || "0.1" : env.ZG_GAS_PER_PROVIDER || "0.015");
  console.log(`  funder has ${formatEther(await zgReader.getBalance({ address: privateKeyToAccount(funderKey).address }))} 0G`);
  for (const r of ROLES.filter((x) => x.role === "verifier" || x.provider)) {
    const address = state.addresses[r.role] as Hex;
    const balance = await zgReader.getBalance({ address });
    if (balance >= need(r.role) / 2n) {
      console.log(`  ${r.role.padEnd(11)} ${formatEther(balance)} 0G (enough)`);
      continue;
    }
    const hash = await zgWallet.sendTransaction({ to: address, value: need(r.role) - balance });
    await zgReader.waitForTransactionReceipt({ hash });
    console.log(`  ${r.role.padEnd(11)} +${formatEther(need(r.role) - balance)} 0G (${hash})`);
  }
}

// 5. One env file per role.
step(`env files in ${TESTNET_DIR}/`);
const passthrough = ["ARKIV_RPC_URL", "MODEL_MAX_DOWNLOAD_MB", "ZEROG_API_KEY", "ZEROG_MODEL", "ZEROG_TRUST_MODE", "ZEROG_CANARY_TRUST_MODE", "ZEROG_CANARY_FALLBACK", "ZEROG_TEE_RPC_URL", "ZG_STORAGE_RPC_URL", "ZG_STORAGE_INDEXER_URL", "ARKIV_APP", "ARKIV_API_KEY", "CANARY_RATE", "CANARY_WINDOW", "CANARY_FAIL_LIMIT", "CANARY_MIN_AGREEMENT", "VERIFIER_FEE_PER_CHUNK_TINYBAR", "SLASH_SETTLE_WAIT"];
// Providers run on 0G Compute unless PROVIDER_BACKEND=openai points them at their own server.
const providerBackend = env.PROVIDER_BACKEND || "0g";
const backendLines =
  providerBackend === "openai"
    ? ["PROVIDER_BACKEND=openai", ...["PROVIDER_MODEL_URL", "PROVIDER_MODEL", "PROVIDER_MODEL_API_KEY"].filter((k) => env[k]).map((k) => `${k}=${env[k]}`)]
    : ["PROVIDER_BACKEND=0g", `PROVIDER_MODEL=${(env.PROVIDER_BACKEND === "0g" && env.PROVIDER_MODEL) || DEFAULT_0G_WORKER_MODEL}`];
for (const r of ROLES) {
  const lines = [
    `# Generated by npm run setup:testnet. Contains a private key: do not commit.`,
    `KINETIC_NETWORK=testnet`,
    `KINETIC_PRIVATE_KEY=${state.keys[r.role]}`,
    ...(state.accounts[r.role] ? [`HEDERA_ACCOUNT_ID=${state.accounts[r.role]}`] : []),
    `HCS_TOPIC_ID=${state.hcsTopicId}`,
    `BOND_VAULT_ADDRESS=${state.vault.address}`,
    ...passthrough.filter((k) => env[k]).map((k) => `${k}=${env[k]}`),
  ];
  if (r.role === "verifier") lines.push(`VERIFIER_COSIGNERS=${ROLES.filter((x) => x.cosigner).map((x) => `http://localhost:${x.cosigner!.port}`).join(",")}`);
  if (r.cosigner) lines.push(`COSIGNER_PORT=${r.cosigner.port}`);
  if (r.provider) {
    lines.push(
      `PROVIDER_NAME=${r.provider.name}`,
      `PROVIDER_GPU=${r.provider.gpu}`,
      `PROVIDER_PORT=${r.provider.port}`,
      `PROVIDER_PRICE_TINYBAR=${r.provider.priceTinybar}`,
      `PROVIDER_BOND_TINYBAR=${env.PROVIDER_BOND_TINYBAR || 100_000_000}`,
      `PROVIDER_BEHAVIOR=${r.provider.behavior}`,
      ...backendLines,
    );
  }
  // Settings added to a role's file by hand (PROVIDER_MODELS, say) survive a re-run. Passthrough
  // settings come from .env alone, so one removed from .env is removed here too.
  const generated = new Set([...lines.filter((l) => !l.startsWith("#")).map((l) => l.split("=")[0]), ...passthrough]);
  const kept = existsSync(roleEnvPath(r.role))
    ? readFileSync(roleEnvPath(r.role), "utf8")
        .split(/\r?\n/)
        .filter((l) => /^[A-Z0-9_]+=/.test(l) && !generated.has(l.split("=")[0]!))
    : [];
  if (kept.length) lines.push("# Kept from the previous file:", ...kept);
  writeFileSync(roleEnvPath(r.role), lines.join("\n") + "\n");
  console.log(`  ${roleEnvPath(r.role)}`);
}

operator.close();
verifierClient.close();
console.log(`\nDone. Check everything with: npm run doctor\nThen run the live job with:   npm run live`);
