import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, decodeEventLog, http, keccak256, parseAbi, toHex, type Hex, type LocalAccount } from "viem";
import type { NetworkConfig } from "../config.js";
import { join } from "node:path";
import { writeJsonAtomic } from "../util/state.js";

// ERC-8004 Trustless Agents on 0G Chain: the public identity and reputation layer for agents.
// Each KINETIC verifier and GPU registers itself in the Identity Registry (an ERC-721: it owns
// its own agent id), with an agent card naming its endpoints and how it can be trusted. After
// every job the verifier gives each GPU feedback in the Reputation Registry: the share of the
// job's hidden checks it passed, measured, not an opinion, with the evidence attached. The
// registry refuses feedback from an agent's own owner, so a GPU can't rate itself.

export const ERC8004_REGISTRATION = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

const IDENTITY_ABI = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

const REPUTATION_ABI = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
]);

/** An agent card (the ERC-8004 registration file). */
export interface AgentCard {
  type: typeof ERC8004_REGISTRATION;
  name: string;
  description: string;
  image?: string;
  services: { name: string; endpoint: string; version?: string }[];
  x402Support: boolean;
  active: boolean;
  registrations: { agentId: number; agentRegistry: string }[];
  supportedTrust: string[];
}

/** A JSON document as a data: URI, so the card or feedback lives on-chain with nothing to host. */
export const dataUri = (doc: unknown) => `data:application/json;base64,${Buffer.from(JSON.stringify(doc)).toString("base64")}`;

export interface Registration {
  agentId: number;
  tx: Hex;
  owner: string;
}

export class Erc8004 {
  private readonly chain;
  private readonly reader;
  private readonly wallet;

  constructor(
    readonly cfg: NetworkConfig["erc8004"],
    private readonly account?: LocalAccount,
  ) {
    this.chain = { id: cfg.chainId, name: "0G Galileo", nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } };
    this.reader = createPublicClient({ chain: this.chain, transport: http(cfg.rpcUrl, { timeout: 30_000, retryCount: 2 }) });
    this.wallet = account ? createWalletClient({ account, chain: this.chain, transport: http(cfg.rpcUrl, { timeout: 30_000, retryCount: 2 }) }) : undefined;
  }

  /** `eip155:<chain>:<identity registry>`, how a card names the registry it's in. */
  get registry(): string {
    return `eip155:${this.cfg.chainId}:${this.cfg.identityRegistry}`;
  }

  private signer() {
    if (!this.wallet || !this.account) throw new Error("ERC-8004 writes need this role's key");
    return { wallet: this.wallet, account: this.account };
  }

  /** Registers this account as a new agent; returns its agent id. */
  async register(agentURI: string): Promise<Registration> {
    const { wallet, account } = this.signer();
    const tx = await wallet.writeContract({ address: this.cfg.identityRegistry, abi: IDENTITY_ABI, functionName: "register", args: [agentURI], account, chain: this.chain });
    const receipt = await this.reader.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`ERC-8004 register reverted (${tx})`);
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.cfg.identityRegistry.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: IDENTITY_ABI, data: log.data, topics: log.topics });
        if (ev.eventName === "Registered") return { agentId: Number(ev.args.agentId), tx, owner: account.address.toLowerCase() };
      } catch {
        // Another event of the registry (Transfer, MetadataSet).
      }
    }
    throw new Error(`ERC-8004 register left no Registered event (${tx})`);
  }

  async setAgentURI(agentId: number, uri: string): Promise<Hex> {
    const { wallet, account } = this.signer();
    const tx = await wallet.writeContract({ address: this.cfg.identityRegistry, abi: IDENTITY_ABI, functionName: "setAgentURI", args: [BigInt(agentId), uri], account, chain: this.chain });
    await this.reader.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
    return tx;
  }

  async ownerOf(agentId: number): Promise<string | null> {
    try {
      return (await this.reader.readContract({ address: this.cfg.identityRegistry, abi: IDENTITY_ABI, functionName: "ownerOf", args: [BigInt(agentId)] })).toLowerCase();
    } catch {
      return null;
    }
  }

  /** Feedback from this account to an agent: a value with decimals, two tags, and its evidence. */
  async giveFeedback(f: { agentId: number; value: number; decimals?: number; tag1: string; tag2?: string; endpoint?: string; evidence?: unknown }): Promise<Hex> {
    const { wallet, account } = this.signer();
    const uri = f.evidence === undefined ? "" : dataUri(f.evidence);
    const hash = f.evidence === undefined ? (`0x${"0".repeat(64)}` as Hex) : keccak256(toHex(JSON.stringify(f.evidence)));
    const tx = await wallet.writeContract({
      address: this.cfg.reputationRegistry,
      abi: REPUTATION_ABI,
      functionName: "giveFeedback",
      args: [BigInt(f.agentId), BigInt(Math.round(f.value)), f.decimals ?? 0, f.tag1, f.tag2 ?? "", f.endpoint ?? "", uri, hash],
      account,
      chain: this.chain,
    });
    await this.reader.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
    return tx;
  }

  /** The average feedback the given clients (e.g. the verifiers) gave an agent, under a tag. */
  async summary(agentId: number, clients: string[], tag1: string, tag2 = ""): Promise<{ count: number; value: number }> {
    const [count, value, decimals] = await this.reader.readContract({ address: this.cfg.reputationRegistry, abi: REPUTATION_ABI, functionName: "getSummary", args: [BigInt(agentId), clients as Hex[], tag1, tag2] });
    return { count: Number(count), value: Number(value) / 10 ** decimals };
  }

  async balance(address: string): Promise<bigint> {
    return this.reader.getBalance({ address: address as Hex });
  }
}

/** Where each role's agent id is remembered, by address. */
const FILE = "erc8004-agents.json";

function remembered(file: string | undefined): Record<string, Registration & { uri: string }> {
  if (!file) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, Registration & { uri: string }>;
  } catch {
    return {};
  }
}

/**
 * This account's agent id, registering it once with the card `cardFor` builds. The card is
 * written again (setAgentURI) with its own registration in it once the id is known, and again
 * whenever it changes. Ownership is checked on-chain, so a stale record never stands in.
 */
export async function ensureAgent(erc: Erc8004, address: string, cardFor: (agentId?: number) => Omit<AgentCard, "type" | "registrations">, stateDir?: string): Promise<Registration> {
  const file = stateDir ? join(stateDir, FILE) : undefined;
  const all = remembered(file);
  const key = address.toLowerCase();
  const full = (agentId: number): AgentCard => ({ type: ERC8004_REGISTRATION, ...cardFor(agentId), registrations: [{ agentId, agentRegistry: erc.registry }] });
  let reg: (Registration & { uri: string }) | undefined = all[key];
  if (reg && (await erc.ownerOf(reg.agentId)) !== key) reg = undefined;
  if (!reg) {
    const first = await retry(() => erc.register(dataUri({ type: ERC8004_REGISTRATION, ...cardFor(), registrations: [] })));
    reg = { ...first, uri: "" };
  }
  const uri = dataUri(full(reg.agentId));
  if (reg.uri !== uri) {
    await retry(() => erc.setAgentURI(reg!.agentId, uri));
    reg.uri = uri;
  }
  // Every role in a process registers at once: re-read just before writing (no await between),
  // so one role's entry never overwrites another's.
  if (file) writeJsonAtomic(file, { ...remembered(file), [key]: reg });
  return { agentId: reg.agentId, tx: reg.tx, owner: reg.owner };
}

/** The 0G RPC now and then rejects a fresh transaction (a stale nonce or gas estimate): try again. */
async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !/invalid parameters|nonce|replacement|timeout|fetch failed/i.test((err as Error).message)) throw err;
      await new Promise((r) => setTimeout(r, 4000 * i));
    }
  }
}
