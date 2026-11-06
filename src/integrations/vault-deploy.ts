import { readFileSync } from "node:fs";
import solc from "solc";
import { createPublicClient, createWalletClient, http, type Abi, type Hex, type LocalAccount } from "viem";
import { hederaTestnet } from "viem/chains";

export function compileVault(path = "contracts/KineticBondVault.sol"): { abi: Abi; bytecode: Hex } {
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { "KineticBondVault.sol": { content: readFileSync(path, "utf8") } },
        settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
      }),
    ),
  );
  const errors = (output.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  const contract = output.contracts["KineticBondVault.sol"].KineticBondVault;
  return { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` };
}

/** Who may slash, and on what terms. Seconds and tinybar. */
export interface VaultRules {
  verifiers: Hex[];
  threshold: number;
  disputeThreshold: number;
  withdrawDelaySeconds: bigint;
  disputeWindowSeconds: bigint;
  resolveTimeoutSeconds: bigint;
  minChallengeTinybar: bigint;
}

/** Rules from the environment: VAULT_VERIFIERS (comma-separated), VAULT_THRESHOLD, VAULT_DISPUTE_THRESHOLD, VAULT_WITHDRAW_DELAY, VAULT_DISPUTE_WINDOW, VAULT_RESOLVE_TIMEOUT, VAULT_MIN_CHALLENGE_TINYBAR. */
export function vaultRulesFromEnv(env: Record<string, string | undefined>, verifiers: Hex[]): VaultRules {
  const n = verifiers.length;
  const threshold = Number(env.VAULT_THRESHOLD || Math.floor(n / 2) + 1);
  return {
    verifiers,
    threshold,
    // Deciding a dispute takes every verifier by default: a larger bar than the one that slashed.
    disputeThreshold: Number(env.VAULT_DISPUTE_THRESHOLD || n),
    withdrawDelaySeconds: BigInt(env.VAULT_WITHDRAW_DELAY || 86_400),
    // Short by default so a testnet run settles its slashes in minutes; use hours in production.
    disputeWindowSeconds: BigInt(env.VAULT_DISPUTE_WINDOW || 60),
    resolveTimeoutSeconds: BigInt(env.VAULT_RESOLVE_TIMEOUT || 600),
    minChallengeTinybar: BigInt(env.VAULT_MIN_CHALLENGE_TINYBAR || 10_000_000),
  };
}

/** Deploys KineticBondVault to Hedera testnet through the JSON-RPC relay. */
export async function deployVault(account: LocalAccount, jsonRpcUrl: string, rules: VaultRules) {
  const { abi, bytecode } = compileVault();
  const transport = http(jsonRpcUrl);
  const wallet = createWalletClient({ account, chain: hederaTestnet, transport });
  const reader = createPublicClient({ chain: hederaTestnet, transport });
  const hash = await wallet.deployContract({
    abi,
    bytecode,
    args: [rules.verifiers, rules.threshold, rules.disputeThreshold, rules.withdrawDelaySeconds, rules.disputeWindowSeconds, rules.resolveTimeoutSeconds, rules.minChallengeTinybar],
  });
  const receipt = await reader.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`vault deployment failed: ${hash}`);
  return { address: receipt.contractAddress, tx: hash };
}
