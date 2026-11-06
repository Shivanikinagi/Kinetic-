import "../src/env.js";
import { parseArgs } from "node:util";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { identityFromEnv, loadNetworkConfig } from "../src/config.js";
import { compileVault, deployVault, vaultRulesFromEnv } from "../src/integrations/vault-deploy.js";

// Compiles contracts/KineticBondVault.sol and deploys it to Hedera testnet through the
// JSON-RPC relay. `--compile-only` just checks that it compiles.
//   VAULT_VERIFIERS              comma-separated verifier EVM addresses (defaults to the deployer alone)
//   VAULT_THRESHOLD              signatures to slash (default: a majority)
//   VAULT_DISPUTE_THRESHOLD      signatures to decide a dispute (default: all verifiers)
//   VAULT_WITHDRAW_DELAY         seconds between requestWithdraw and withdraw (default 86400)
//   VAULT_DISPUTE_WINDOW         seconds a slash stays open to dispute (default 60)
//   VAULT_RESOLVE_TIMEOUT        seconds to decide a dispute before it is cancelled (default 600)
//   VAULT_MIN_CHALLENGE_TINYBAR  smallest challenge bond (default 10000000 = 0.1 ℏ)

const { values } = parseArgs({ options: { "compile-only": { type: "boolean", default: false } } });

const { bytecode } = compileVault();
console.log(`compiled KineticBondVault (${(bytecode.length - 2) / 2} bytes)`);
if (values["compile-only"]) process.exit(0);

const cfg = loadNetworkConfig();
const account = privateKeyToAccount(identityFromEnv().privateKey);
const verifiers = (process.env.VAULT_VERIFIERS || account.address).split(",").map((a) => a.trim() as Hex);
const rules = vaultRulesFromEnv(process.env, verifiers);
const { address, tx } = await deployVault(account, cfg.hedera.jsonRpcUrl, rules);
console.log(`deployed at ${address} (tx ${tx})`);
console.log(`verifiers ${verifiers.join(", ")}`);
console.log(`${rules.threshold} of ${verifiers.length} to slash, ${rules.disputeThreshold} to decide a dispute, ${rules.disputeWindowSeconds}s dispute window`);
console.log(`HashScan: https://hashscan.io/testnet/contract/${address}`);
console.log(`\nBOND_VAULT_ADDRESS=${address}`);
