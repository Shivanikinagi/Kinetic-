import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseEnv } from "node:util";
import { AccountCreateTransaction, AccountId, AccountUpdateTransaction, Client, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { NetworkConfig } from "../config.js";
import { arkivChain } from "../integrations/arkiv.js";

// The steps `kinetic init` and `kinetic status` are made of. Each one reads or changes one thing.

export const HEDERA_FAUCET = "https://portal.hedera.com/faucet";
export const ARKIV_FAUCET = "https://hub.arkiv.network/faucet";

export interface MirrorAccount {
  id: string;
  balanceTinybar: bigint;
  /** Created by sending HBAR to the EVM address (e.g. by the faucet): no key until its first transaction. */
  hollow: boolean;
  evmAddress?: string;
}

/** The Hedera account behind an EVM address or account id, from the mirror node. */
export async function mirrorAccount(mirrorUrl: string, idOrAddress: string): Promise<MirrorAccount | undefined> {
  const res = await fetch(`${mirrorUrl}/api/v1/accounts/${idOrAddress}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`mirror node answered ${res.status} for ${idOrAddress}`);
  const a = (await res.json()) as { account: string; balance: { balance: number }; key: unknown; evm_address?: string };
  return { id: a.account, balanceTinybar: BigInt(a.balance.balance), hollow: a.key === null, evmAddress: a.evm_address?.toLowerCase() };
}

/** A key as the Hedera portal shows it: 0x-hex ECDSA, raw hex or DER. */
export function parseOperatorKey(raw: string): PrivateKey {
  if (raw.startsWith("0x")) return PrivateKey.fromStringECDSA(raw.slice(2));
  try {
    return PrivateKey.fromStringDer(raw);
  } catch {
    return PrivateKey.fromStringECDSA(raw);
  }
}

/** A new ECDSA account with the key's EVM alias, funded from an operator account you already have. */
export async function createAccount(operatorId: string, operatorKey: string, privateKey: Hex, hbar: number): Promise<string> {
  const client = Client.forTestnet().setOperator(AccountId.fromString(operatorId), parseOperatorKey(operatorKey));
  try {
    const key = PrivateKey.fromStringECDSA(privateKey.slice(2));
    const response = await new AccountCreateTransaction().setECDSAKeyWithAlias(key).setInitialBalance(new Hbar(hbar)).execute(client);
    return (await response.getReceipt(client)).accountId!.toString();
  } finally {
    client.close();
  }
}

/**
 * Gives a hollow account its key: any transaction it pays for and signs completes it. This one
 * only sets the account memo, so it costs a fraction of a cent of testnet HBAR.
 */
export async function completeHollowAccount(accountId: string, privateKey: Hex): Promise<void> {
  const client = Client.forTestnet().setOperator(AccountId.fromString(accountId), PrivateKey.fromStringECDSA(privateKey.slice(2)));
  try {
    const response = await new AccountUpdateTransaction().setAccountId(accountId).setAccountMemo("KINETIC").execute(client);
    await response.getReceipt(client);
  } finally {
    client.close();
  }
}

type ArkivNet = NetworkConfig["arkiv"];
const arkivTransport = (net: ArkivNet) => http(net.rpcUrl, net.apiKey ? { fetchOptions: { headers: { "X-API-KEY": net.apiKey } } } : {});

export async function arkivBalance(net: ArkivNet, address: string): Promise<bigint> {
  return createPublicClient({ chain: arkivChain(net), transport: arkivTransport(net) }).getBalance({ address: address as Hex });
}

/** Sends Arkiv gas from a wallet you funded at the faucet. */
export async function fundArkiv(net: ArkivNet, funderKey: Hex, to: string, amountWei: bigint): Promise<string> {
  const chain = arkivChain(net);
  const wallet = createWalletClient({ account: privateKeyToAccount(funderKey), chain, transport: arkivTransport(net) });
  const hash = await wallet.sendTransaction({ to: to as Hex, value: amountWei });
  await createPublicClient({ chain, transport: arkivTransport(net) }).waitForTransactionReceipt({ hash });
  return hash;
}

/** The first NVIDIA GPU's name, if nvidia-smi is installed. */
export function detectGpu(): string | undefined {
  try {
    const out = execFileSync("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const [name, memory] = out.split("\n")[0].split(",").map((s) => s.trim());
    return name ? `${name}${memory ? ` (${memory})` : ""}` : undefined;
  } catch {
    return undefined;
  }
}

/** Models on an OpenAI-compatible server (Ollama, vLLM, llama.cpp, LM Studio), if one answers. */
export async function detectModels(url: string): Promise<string[] | undefined> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return undefined;
    return ((await res.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [];
  } catch {
    return undefined;
  }
}

/** Polls until `check` returns a value, or gives up after `timeoutMs`. */
export async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs: number, everyMs = 5000): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() >= end) return undefined;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export function readEnvFile(path: string): Record<string, string> | undefined {
  return existsSync(path) ? (parseEnv(readFileSync(path, "utf8")) as Record<string, string>) : undefined;
}

export function writeEnvFile(path: string, header: string, values: Record<string, string | undefined>): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines = Object.entries(values)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`);
  writeFileSync(path, `${header}\n${lines.join("\n")}\n`, { mode: 0o600 });
}
