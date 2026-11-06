import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";

// The roles a full testnet run needs, and where their keys and settings live.
// `.kinetic/` is git-ignored: it holds private keys.

export const TESTNET_DIR = ".kinetic/testnet";

export interface RoleSpec {
  role: string;
  hbar: number;
  provider?: { name: string; gpu: string; priceTinybar: bigint; behavior: string; port: number };
  /** A cosigning verifier: one of the vault's verifiers. It only reads and signs, so it needs no Hedera account. */
  cosigner?: { port: number };
  /** Writes nothing to Arkiv, so it needs no Arkiv gas. */
  noArkiv?: boolean;
}

// Every provider runs on 0G Compute. Two are honest; three are adversarial test providers
// that really cheat on the real networks, and say so in their offers. (Named atlas, nimbus,
// cheapo, flicker and shoddy in runs before 2026-11-01.)
const ZG = "0G Compute (TeeML)";

export const ROLES: RoleSpec[] = [
  { role: "verifier", hbar: 25 },
  // The vault needs 2 of these 3 verifiers to slash and all 3 to decide a dispute.
  { role: "verifier-2", hbar: 0, cosigner: { port: 4510 } },
  { role: "verifier-3", hbar: 0, cosigner: { port: 4520 } },
  { role: "buyer", hbar: 20 },
  // Publishes models (paying the listing fee) and receives their royalties. The verifier writes the listings.
  { role: "creator", hbar: 3, noArkiv: true },
  { role: "provider-1", hbar: 5, provider: { name: "BluePeak", gpu: ZG, priceTinybar: 100_000n, behavior: "honest", port: 5101 } },
  { role: "provider-2", hbar: 5, provider: { name: "Riverstone", gpu: ZG, priceTinybar: 120_000n, behavior: "honest", port: 5102 } },
  { role: "provider-3", hbar: 5, provider: { name: "QuickCompute", gpu: ZG, priceTinybar: 60_000n, behavior: "degrade-after:3", port: 5103 } },
  { role: "provider-4", hbar: 5, provider: { name: "EdgeRelay", gpu: ZG, priceTinybar: 80_000n, behavior: "offline-after:5", port: 5104 } },
  // Never calls a model, so it has no compute to declare.
  { role: "provider-5", hbar: 5, provider: { name: "BudgetGPU", gpu: "none", priceTinybar: 40_000n, behavior: "lazy", port: 5105 } },
];

export interface TestnetState {
  keys: Record<string, `0x${string}`>;
  accounts: Record<string, string>;
  addresses: Record<string, string>;
  hcsTopicId?: string;
  /** `version` 2: the quorum vault. A vault without it is the old single-arbiter one. */
  vault?: { address: `0x${string}`; tx: string; version?: number };
  /** Vaults an earlier setup replaced: providers may still have bonds to withdraw there (npm run bonds). */
  retiredVaults?: { address: `0x${string}`; tx: string; version?: number }[];
  arkivFunded: Record<string, string>;
}

const statePath = `${TESTNET_DIR}/state.json`;

export function loadState(): TestnetState {
  if (!existsSync(statePath)) return { keys: {}, accounts: {}, addresses: {}, arkivFunded: {} };
  return JSON.parse(readFileSync(statePath, "utf8"));
}

export function saveState(state: TestnetState): void {
  mkdirSync(TESTNET_DIR, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function roleEnvPath(role: string): string {
  return `${TESTNET_DIR}/${role}.env`;
}

export function loadRoleEnv(role: string): Record<string, string | undefined> {
  const path = roleEnvPath(role);
  if (!existsSync(path)) throw new Error(`${path} not found: run npm run setup:testnet first`);
  return { ...process.env, ...parseEnv(readFileSync(path, "utf8")) };
}
