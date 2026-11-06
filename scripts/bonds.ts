import "../src/env.js";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, formatUnits, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";
import { loadNetworkConfig } from "../src/config.js";
import { loadState, saveState } from "../src/testnet/roles.js";

// Bonds held in KINETIC vaults by the testnet roles, in the current vault and in any vault an
// earlier setup replaced. Withdrawing takes two steps: request (starts the vault's delay, 24 h by
// default), then withdraw once the delay has passed. A provider that requested gets no new work.
//
//   npm run bonds -- status               every role's bond in every known vault (read-only)
//   npm run bonds -- request [--yes]      start the withdrawal delay for every bonded role
//   npm run bonds -- withdraw [--yes]     take out every bond whose delay has passed
//   --vault 0x…  only this vault · --role provider-1  only this role · --keys file.json  extra role keys
//     (e.g. a backed-up state.json with keys an earlier --rotate replaced)

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { yes: { type: "boolean", default: false }, vault: { type: "string" }, role: { type: "string", multiple: true }, keys: { type: "string", multiple: true } },
});
const command = positionals[0] ?? "status";
const cfg = loadNetworkConfig({ ...process.env, KINETIC_NETWORK: "testnet", BOND_VAULT_ADDRESS: "0x0000000000000000000000000000000000000000" });
const state = loadState();
const reader = createPublicClient({ chain: hederaTestnet, transport: http(cfg.hedera.jsonRpcUrl) });

// requestWithdraw/withdraw are the same in both vault versions; bondOf returns 3 values in the old one.
const ABI = parseAbi(["function requestWithdraw()", "function withdraw()", "function withdrawDelay() view returns (uint64)"]);
const BOND_V2 = parseAbi(["function bondOf(address) view returns (uint256 amount, uint64 unlockAt, bool slashed, uint32 pending)"]);
const BOND_V1 = parseAbi(["function bondOf(address) view returns (uint256 amount, uint64 unlockAt, bool slashed)"]);

// Also the key and vault in this machine's .env: an outside operator has no testnet state, only that.
const envVault = /^0x[0-9a-fA-F]{40}$/.test(process.env.BOND_VAULT_ADDRESS ?? "") ? (process.env.BOND_VAULT_ADDRESS as Hex) : undefined;
const vaults = values.vault ? [values.vault as Hex] : [...new Set([state.vault?.address, envVault, ...(state.retiredVaults ?? []).map((v) => v.address)].filter((v): v is Hex => !!v).map((v) => v.toLowerCase() as Hex))];
const keys: Record<string, Hex> = { ...state.keys };
const envKey = process.env.KINETIC_PRIVATE_KEY;
if (envKey && /^0x[0-9a-fA-F]{64}$/.test(envKey) && !Object.values(keys).includes(envKey as Hex)) keys[".env key"] = envKey as Hex;
for (const file of values.keys ?? []) {
  if (!existsSync(file)) throw new Error(`${file} not found`);
  for (const [role, key] of Object.entries((JSON.parse(readFileSync(file, "utf8")) as { keys: Record<string, Hex> }).keys)) {
    const address = privateKeyToAccount(key).address;
    if (!Object.values(keys).some((k) => privateKeyToAccount(k).address === address)) keys[`${role} (earlier key)`] = key;
  }
}
const roles = Object.entries(keys).filter(([role]) => !values.role || values.role.some((r) => role.startsWith(r)));

async function bondOf(vault: Hex, address: Hex) {
  try {
    const [amount, unlockAt, slashed, pending] = await reader.readContract({ address: vault, abi: BOND_V2, functionName: "bondOf", args: [address] });
    return { amount, unlockAt: Number(unlockAt), slashed, pending: Number(pending) };
  } catch {
    const [amount, unlockAt, slashed] = await reader.readContract({ address: vault, abi: BOND_V1, functionName: "bondOf", args: [address] });
    return { amount, unlockAt: Number(unlockAt), slashed, pending: 0 };
  }
}

const hbar = (tinybar: bigint) => `${formatUnits(tinybar, 8)} ℏ`;
const now = Math.floor(Date.now() / 1000);
let pendingWork = 0;
for (const vault of vaults) {
  const delay = await reader.readContract({ address: vault, abi: ABI, functionName: "withdrawDelay" }).catch(() => undefined);
  const current = vault === state.vault?.address.toLowerCase() || (!state.vault && vault === envVault?.toLowerCase());
  console.log(`\nvault ${vault}${current ? " (current)" : " (replaced)"} · withdraw delay ${delay ?? "?"} s`);
  for (const [role, key] of roles) {
    const account = privateKeyToAccount(key);
    const b = await bondOf(vault, account.address);
    if (b.amount === 0n && b.unlockAt === 0) continue;
    const when = b.unlockAt === 0 ? "not requested" : b.unlockAt <= now ? "withdrawable now" : `withdrawable at ${new Date(b.unlockAt * 1000).toISOString()}`;
    console.log(`  ${role.padEnd(24)} ${account.address} ${hbar(b.amount).padStart(14)} · ${when}${b.slashed ? " · slashed" : ""}${b.pending ? ` · ${b.pending} open slash(es)` : ""}`);
    const action = command === "request" && b.amount > 0n && b.unlockAt === 0 ? "requestWithdraw" : command === "withdraw" && b.amount > 0n && b.unlockAt !== 0 && b.unlockAt <= now && !b.pending ? "withdraw" : undefined;
    if (!action) continue;
    pendingWork += 1;
    if (!values.yes) {
      console.log(`    would send ${action}() from ${role} (add --yes)`);
      continue;
    }
    const wallet = createWalletClient({ account, chain: hederaTestnet, transport: http(cfg.hedera.jsonRpcUrl) });
    const hash = await wallet.writeContract({ address: vault, abi: ABI, functionName: action });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    console.log(`    ${action}() ${receipt.status}: https://hashscan.io/testnet/transaction/${hash}`);
  }
}
if (command !== "status" && pendingWork === 0) console.log(`\nnothing to ${command}.`);
saveState(state);
