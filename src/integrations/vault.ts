import { createPublicClient, createWalletClient, decodeEventLog, encodeEventTopics, http, parseAbi, parseEventLogs, type Hex, type LocalAccount } from "viem";
import { hederaTestnet } from "viem/chains";
import type { NetworkConfig } from "../config.js";
import { verdictArgs, type SlashVerdict, type VaultDomain } from "../core/verdict.js";
import { signedPost } from "../util/sign.js";

export { evidenceBytes32, jobIdBytes32 } from "../core/verdict.js";

export const VAULT_ABI = parseAbi([
  "struct Verdict { address provider; address buyer; bytes32 jobId; uint32 chunk; bytes32 resultHash; uint256 refund; bytes32 evidence; }",
  "function bond() payable",
  "function requestWithdraw()",
  "function withdraw()",
  "function proposeSlash(Verdict v, bytes[] signatures) payable returns (bytes32)",
  "function dispute(bytes32 id) payable",
  "function resolveDispute(bytes32 id, bool upheld, bytes[] signatures)",
  "function executeSlash(bytes32 id)",
  "function bondOf(address provider) view returns (uint256 amount, uint64 unlockAt, bool slashed, uint32 pending)",
  "function slashes(bytes32 id) view returns (address provider, address buyer, bytes32 jobId, uint32 chunk, bytes32 resultHash, bytes32 evidence, uint256 refund, uint256 challenge, uint64 proposedAt, uint64 disputedAt, uint8 status)",
  "function verifiers() view returns (address[])",
  "function isVerifier(address) view returns (bool)",
  "function threshold() view returns (uint8)",
  "function disputeThreshold() view returns (uint8)",
  "function disputeWindow() view returns (uint64)",
  "function resolveTimeout() view returns (uint64)",
  "function minChallenge() view returns (uint256)",
  "function burned() view returns (uint256)",
  // HIP-1215 scheduled finalization and HIP-351 seeds (vaults deployed before them have neither).
  "function SCHEDULE_GAS_LIMIT() view returns (uint256)",
  "function scheduleOf(bytes32 id) view returns (address)",
  "function scheduleFloat() view returns (uint256)",
  "function committed() view returns (uint256)",
  "function reservedFees() view returns (uint256)",
  "function drawSeed(bytes32 tag) returns (bytes32)",
  "function seeds(bytes32 tag) view returns (bytes32 seed, uint64 at)",
  "event SlashScheduled(bytes32 indexed id, address schedule, uint64 at, uint256 budget)",
  "event ScheduleFailed(bytes32 indexed id, int64 responseCode)",
  "event ScheduleCancelled(bytes32 indexed id, address schedule, bool deleted)",
  "event SeedDrawn(bytes32 indexed tag, bytes32 seed)",
  "error AlreadyDrawn()",
  "error NoRandomness()",
  "event SlashProposed(bytes32 indexed id, address indexed provider, address indexed buyer, bytes32 jobId, uint32 chunk, bytes32 resultHash, uint256 refund)",
  "event SlashDisputed(bytes32 indexed id, uint256 challenge)",
  "event SlashExecuted(bytes32 indexed id, address indexed provider, uint256 refund, uint256 burnt, uint256 challenge)",
  "event SlashReleased(bytes32 indexed id, address indexed provider, uint8 status, uint256 challenge)",
  // Custom errors, so a revert says which rule it broke.
  "error BadQuorum()",
  "error NothingBonded()",
  "error NotRequested()",
  "error Locked(uint64 unlockAt)",
  "error Frozen()",
  "error ProviderSlashed()",
  "error AlreadySlashed()",
  "error WrongStatus()",
  "error NotProvider()",
  "error WindowClosed()",
  "error ChallengeTooSmall()",
  "error NotYet(uint64 at)",
  "error BadSignature()",
  "error SignersNotSorted()",
  "error NotVerifier(address signer)",
  "error NoQuorum(uint256 have, uint256 need)",
  "error TransferFailed()",
]);

export interface BondState {
  amountTinybar: bigint;
  unlockAt: number;
  slashed: boolean;
  /** Slashes still open against the provider; its bond can't be withdrawn meanwhile. */
  pending: number;
}

/** The vault's verifier set and slashing rules. */
export interface VaultInfo extends VaultDomain {
  verifiers: string[];
  /** Signatures needed to propose a slash. */
  threshold: number;
  /** Signatures needed to decide a dispute. */
  disputeThreshold: number;
  disputeWindowSeconds: number;
  resolveTimeoutSeconds: number;
  minChallengeTinybar: bigint;
}

export type SlashStatus = "none" | "proposed" | "disputed" | "executed" | "overturned" | "cancelled";
const STATUSES: SlashStatus[] = ["none", "proposed", "disputed", "executed", "overturned", "cancelled"];

export interface SlashRecord {
  id: Hex;
  status: SlashStatus;
  provider: string;
  buyer: string;
  refundTinybar: bigint;
  challengeTinybar: bigint;
  /** Unix seconds. */
  proposedAt: number;
  disputedAt: number;
}

/** What settling a slash did: refund to the buyer and bond burned, or released back to the provider. */
export interface Settlement {
  tx: string;
  status: "executed" | "overturned" | "cancelled";
  refundTinybar: bigint;
  burnedTinybar: bigint;
  challengeTinybar: bigint;
  /** Run by Hedera from the vault's own schedule (HIP-1215), not sent by anyone. */
  scheduled?: boolean;
}

export interface BondVault {
  info(): Promise<VaultInfo>;
  bondOf(provider: string): Promise<BondState>;
  postBond(amountTinybar: bigint): Promise<string>;
  /** Starts the withdrawal timelock. Buyers stop routing work to the provider from then on. */
  requestWithdraw(): Promise<string>;
  /**
   * Opens a slash with a quorum of verifier signatures, sorted by signer. Anyone may submit it.
   * On Hedera it also pays the vault to execute the slash itself when the window closes
   * (HIP-1215); `scheduled` says when, if the network took the schedule.
   */
  proposeSlash(verdict: SlashVerdict, signatures: Hex[]): Promise<{ tx: string; slashId: Hex; scheduled?: ScheduledCall }>;
  /** The provider's challenge to a proposed slash. */
  dispute(slashId: Hex, challengeTinybar: bigint): Promise<string>;
  resolveDispute(slashId: Hex, upheld: boolean, signatures: Hex[]): Promise<Settlement>;
  /** Executes an undisputed slash after its window, or cancels an undecided dispute after its timeout. */
  executeSlash(slashId: Hex): Promise<Settlement>;
  slashOf(slashId: Hex): Promise<SlashRecord>;
  /** How a slash someone else settled (e.g. the vault's own scheduled call) came out, from the ledger. */
  settlementOf?(slashId: Hex, sinceUnix: number): Promise<Settlement | undefined>;
  /** Draws the one Hedera PRNG seed for a tag (verifiers only), recorded in the vault with its time. */
  drawSeed?(tag: Hex): Promise<SeedDraw>;
  /** The seed drawn for a tag, if any. */
  seedOf?(tag: Hex): Promise<SeedDraw | undefined>;
}

/** The vault's scheduled executeSlash (HIP-1215): the schedule's address and its expiry second. */
export interface ScheduledCall {
  schedule: string;
  at: number;
  budgetTinybar: bigint;
}

export interface SeedDraw {
  seed: Hex;
  /** Consensus time of the draw, unix seconds. */
  drawnAt: number;
  tx?: string;
}

const WEIBAR_PER_TINYBAR = 10_000_000_000n;
/** Extra gas for a proposal that schedules: the Schedule Service's own charge, which a relay's estimate may leave out. */
const SCHEDULE_GAS_HEADROOM = 300_000n;

/** KineticBondVault on Hedera testnet through the JSON-RPC relay. */
export class EvmBondVault implements BondVault {
  private readonly reader;
  private readonly writer;
  private cachedInfo?: Promise<VaultInfo>;

  private scheduleGas?: Promise<bigint | null>;

  constructor(
    account: LocalAccount,
    private readonly address: Hex,
    private readonly cfg: NetworkConfig["hedera"],
  ) {
    const transport = http(cfg.jsonRpcUrl);
    this.reader = createPublicClient({ chain: hederaTestnet, transport });
    this.writer = createWalletClient({ chain: hederaTestnet, transport, account });
  }

  info(): Promise<VaultInfo> {
    const read = <T>(functionName: string) => this.reader.readContract({ address: this.address, abi: VAULT_ABI, functionName } as never) as Promise<T>;
    this.cachedInfo ??= Promise.all([
      read<readonly Hex[]>("verifiers"),
      read<number>("threshold"),
      read<number>("disputeThreshold"),
      read<bigint>("disputeWindow"),
      read<bigint>("resolveTimeout"),
      read<bigint>("minChallenge"),
    ]).then(([verifiers, threshold, disputeThreshold, window, timeout, minChallenge]) => ({
      address: this.address,
      chainId: hederaTestnet.id,
      verifiers: verifiers.map((v) => v.toLowerCase()),
      threshold: Number(threshold),
      disputeThreshold: Number(disputeThreshold),
      disputeWindowSeconds: Number(window),
      resolveTimeoutSeconds: Number(timeout),
      minChallengeTinybar: minChallenge,
    }));
    this.cachedInfo.catch(() => (this.cachedInfo = undefined));
    return this.cachedInfo;
  }

  async bondOf(provider: string): Promise<BondState> {
    const [amount, unlockAt, slashed, pending] = await this.reader.readContract({
      address: this.address,
      abi: VAULT_ABI,
      functionName: "bondOf",
      args: [provider as Hex],
    });
    return { amountTinybar: amount, unlockAt: Number(unlockAt), slashed, pending: Number(pending) };
  }

  async slashOf(slashId: Hex): Promise<SlashRecord> {
    const s = await this.reader.readContract({ address: this.address, abi: VAULT_ABI, functionName: "slashes", args: [slashId] });
    const [provider, buyer, , , , , refund, challenge, proposedAt, disputedAt, status] = s;
    return {
      id: slashId,
      status: STATUSES[Number(status)] ?? "none",
      provider: provider.toLowerCase(),
      buyer: buyer.toLowerCase(),
      refundTinybar: refund,
      challengeTinybar: challenge,
      proposedAt: Number(proposedAt),
      disputedAt: Number(disputedAt),
    };
  }

  // The JSON-RPC relay simulates against state that can trail consensus by a few seconds, so
  // a write right after a related one (a slash just after a bond) can falsely revert in
  // simulation. Retry a few times before giving up.
  private async withRelayRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
    for (let i = 1; ; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i >= attempts) throw err;
        await new Promise((r) => setTimeout(r, 3000 * i));
      }
    }
  }

  /** `extraGas`: added to the relay's estimate, for system contract work it may not simulate. */
  private async write(functionName: string, args: unknown[] = [], valueTinybar = 0n, extraGas = 0n) {
    const call = { address: this.address, abi: VAULT_ABI, functionName, args, value: valueTinybar * WEIBAR_PER_TINYBAR } as never;
    const hash = await this.withRelayRetry(async () => {
      const gas = extraGas > 0n ? (await this.reader.estimateContractGas({ ...(call as object), account: this.writer.account } as never)) + extraGas : undefined;
      return this.writer.writeContract({ ...(call as object), ...(gas ? { gas } : {}) } as never);
    });
    const receipt = await this.reader.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    return { hash, logs: parseEventLogs({ abi: VAULT_ABI, logs: receipt.logs }) };
  }

  async postBond(amountTinybar: bigint): Promise<string> {
    return (await this.write("bond", [], amountTinybar)).hash;
  }

  async requestWithdraw(): Promise<string> {
    return (await this.write("requestWithdraw")).hash;
  }

  /** The gas the vault gives its scheduled executeSlash; null for a vault deployed before scheduling. */
  private scheduleGasLimit(): Promise<bigint | null> {
    this.scheduleGas ??= this.reader.readContract({ address: this.address, abi: VAULT_ABI, functionName: "SCHEDULE_GAS_LIMIT" }).catch((err: Error) => {
      // An older vault has no such function; anything else (the relay down) is asked again next time.
      if (!/revert|returned no data|does not have the function/i.test(err.message)) this.scheduleGas = undefined;
      return null;
    });
    return this.scheduleGas;
  }

  /**
   * What a proposal pays for the vault's scheduled executeSlash: its gas limit at the current
   * gas price plus 10%, since Hedera charges at most that (at least 80% of it). What the call
   * doesn't use stays in the vault's fee float, never in the bonds.
   */
  async scheduleFee(): Promise<bigint> {
    const gas = await this.scheduleGasLimit();
    if (!gas) return 0n;
    if (this.cfg.vaultScheduleFeeTinybar !== undefined) return this.cfg.vaultScheduleFeeTinybar;
    const tinybarPerGas = ((await this.reader.getGasPrice()) + WEIBAR_PER_TINYBAR - 1n) / WEIBAR_PER_TINYBAR;
    return (gas * tinybarPerGas * 11n) / 10n;
  }

  async proposeSlash(verdict: SlashVerdict, signatures: Hex[]) {
    const args = [verdictArgs(verdict), signatures];
    // With a dispute window, pay the vault to finalize the slash itself when it closes.
    const fee = (await this.info()).disputeWindowSeconds > 0 ? await this.scheduleFee().catch(() => 0n) : 0n;
    let sent: Awaited<ReturnType<EvmBondVault["write"]>>;
    try {
      sent = await this.write("proposeSlash", args, fee, fee > 0n ? SCHEDULE_GAS_HEADROOM : 0n);
    } catch (err) {
      // Scheduling is best-effort: never let it stand in the way of the slash.
      if (fee === 0n) throw err;
      sent = await this.write("proposeSlash", args);
    }
    const { hash, logs } = sent;
    const proposed = logs.find((l) => l.eventName === "SlashProposed");
    if (!proposed) throw new Error(`proposeSlash emitted no SlashProposed: ${hash}`);
    const s = logs.find((l) => l.eventName === "SlashScheduled")?.args as { schedule: Hex; at: bigint; budget: bigint } | undefined;
    return { tx: hash, slashId: (proposed.args as { id: Hex }).id, ...(s ? { scheduled: { schedule: s.schedule.toLowerCase(), at: Number(s.at), budgetTinybar: s.budget } } : {}) };
  }

  /**
   * A settled slash's SlashExecuted or SlashReleased event, found on the mirror node (which
   * wants a time range of at most 7 days per query): for slashes the vault's scheduled call, or
   * another verifier, settled.
   */
  async settlementOf(slashId: Hex, sinceUnix: number): Promise<Settlement | undefined> {
    const topics = (["SlashExecuted", "SlashReleased"] as const).map((eventName) => encodeEventTopics({ abi: VAULT_ABI, eventName })[0]);
    const now = Math.ceil(Date.now() / 1000) + 60;
    const WEEK = 7 * 86_400 - 1;
    for (let from = Math.max(0, Math.floor(sinceUnix) - 5); from < now; from += WEEK + 1) {
      for (const topic0 of topics) {
        const url = `${this.cfg.mirrorUrl}/api/v1/contracts/${this.address}/results/logs?topic0=${topic0}&topic1=${slashId.toLowerCase()}&timestamp=gte:${from}&timestamp=lte:${Math.min(from + WEEK, now)}&order=asc&limit=5`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`mirror logs failed (${res.status})`);
        const body = (await res.json()) as { logs?: { data: Hex; topics: Hex[]; transaction_hash: string; timestamp?: string }[] };
        const log = body.logs?.[0];
        if (!log) continue;
        const e = decodeEventLog({ abi: VAULT_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        const settled = settlementOf({ hash: log.transaction_hash, logs: [{ eventName: e.eventName, args: e.args }] });
        // Whether the vault's scheduled call ran it: the mirror node marks scheduled transactions.
        const tx = log.timestamp ? await fetch(`${this.cfg.mirrorUrl}/api/v1/transactions?timestamp=${log.timestamp}`).then((r) => (r.ok ? (r.json() as Promise<{ transactions?: { scheduled?: boolean }[] }>) : undefined)).catch(() => undefined) : undefined;
        return { ...settled, scheduled: tx?.transactions?.[0]?.scheduled === true };
      }
    }
    return undefined;
  }

  async drawSeed(tag: Hex): Promise<SeedDraw> {
    const { hash, logs } = await this.write("drawSeed", [tag]);
    const drawn = logs.find((l) => l.eventName === "SeedDrawn")?.args as { seed: Hex } | undefined;
    if (!drawn) throw new Error(`drawSeed emitted no SeedDrawn: ${hash}`);
    // The relay can trail consensus by a few seconds: wait for the recorded draw to show.
    for (let i = 0; i < 6; i++) {
      const recorded = await this.seedOf(tag);
      if (recorded) return { ...recorded, tx: hash };
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`seed for ${tag} not readable after ${hash}`);
  }

  async seedOf(tag: Hex): Promise<SeedDraw | undefined> {
    const [seed, at] = await this.reader.readContract({ address: this.address, abi: VAULT_ABI, functionName: "seeds", args: [tag] });
    return at > 0n ? { seed, drawnAt: Number(at) } : undefined;
  }

  /**
   * Gas to add to a call that may delete or move the slash's scheduled call: the Schedule
   * Service's charge, which the relay's estimate may not include. None on older vaults.
   */
  private async scheduleHeadroom(): Promise<bigint> {
    return (await this.scheduleGasLimit()) ? SCHEDULE_GAS_HEADROOM : 0n;
  }

  async dispute(slashId: Hex, challengeTinybar: bigint): Promise<string> {
    return (await this.write("dispute", [slashId], challengeTinybar, await this.scheduleHeadroom())).hash;
  }

  async resolveDispute(slashId: Hex, upheld: boolean, signatures: Hex[]): Promise<Settlement> {
    return settlementOf(await this.write("resolveDispute", [slashId, upheld, signatures], 0n, await this.scheduleHeadroom()));
  }

  async executeSlash(slashId: Hex): Promise<Settlement> {
    const sent = await this.write("executeSlash", [slashId], 0n, await this.scheduleHeadroom());
    if (sent.logs.some((l) => l.eventName === "SlashExecuted" || l.eventName === "SlashReleased")) return settlementOf(sent);
    // Already settled (by the vault's scheduled call, say): executeSlash left it as it was.
    const found = await this.settlementOf(slashId, (await this.slashOf(slashId)).proposedAt);
    if (!found) throw new Error(`no settlement event for ${slashId} (tx ${sent.hash})`);
    return found;
  }
}

function settlementOf({ hash, logs }: { hash: string; logs: { eventName: string; args: unknown }[] }): Settlement {
  for (const l of logs) {
    if (l.eventName === "SlashExecuted") {
      const a = l.args as { refund: bigint; burnt: bigint; challenge: bigint };
      return { tx: hash, status: "executed", refundTinybar: a.refund, burnedTinybar: a.burnt, challengeTinybar: a.challenge };
    }
    if (l.eventName === "SlashReleased") {
      const a = l.args as { status: number; challenge: bigint };
      return { tx: hash, status: STATUSES[a.status] as Settlement["status"], refundTinybar: 0n, burnedTinybar: 0n, challengeTinybar: a.challenge };
    }
  }
  throw new Error(`no settlement event in ${hash}`);
}

export class DevnetBondVault implements BondVault {
  constructor(
    private readonly account: LocalAccount,
    private readonly devnetUrl: string,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.devnetUrl}/devnet/vault/${path}`);
    if (!res.ok) throw new Error(`vault read failed (${res.status})`);
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await signedPost(this.account, `${this.devnetUrl}/devnet/vault/${path}`, body);
    if (!res.ok) throw new Error(`vault ${path} failed (${res.status}): ${await res.text()}`);
    return (await res.json()) as T;
  }

  async info(): Promise<VaultInfo> {
    const i = await this.get<Omit<VaultInfo, "minChallengeTinybar"> & { minChallengeTinybar: string }>("info");
    return { ...i, minChallengeTinybar: BigInt(i.minChallengeTinybar) };
  }

  async bondOf(provider: string): Promise<BondState> {
    const body = await this.get<{ amount: string; unlockAt: number; slashed: boolean; pending: number }>(`bonds/${provider.toLowerCase()}`);
    return { amountTinybar: BigInt(body.amount), unlockAt: body.unlockAt, slashed: body.slashed, pending: body.pending };
  }

  async slashOf(slashId: Hex): Promise<SlashRecord> {
    const s = await this.get<Omit<SlashRecord, "refundTinybar" | "challengeTinybar"> & { refundTinybar: string; challengeTinybar: string }>(`slashes/${slashId}`);
    return { ...s, refundTinybar: BigInt(s.refundTinybar), challengeTinybar: BigInt(s.challengeTinybar) };
  }

  async postBond(amountTinybar: bigint): Promise<string> {
    return (await this.post<{ tx: string }>("bond", { amount: amountTinybar.toString() })).tx;
  }

  async requestWithdraw(): Promise<string> {
    return (await this.post<{ tx: string }>("request-withdraw", {})).tx;
  }

  async proposeSlash(verdict: SlashVerdict, signatures: Hex[]) {
    return this.post<{ tx: string; slashId: Hex }>("propose", { verdict: { ...verdict, refundTinybar: verdict.refundTinybar.toString() }, signatures });
  }

  async dispute(slashId: Hex, challengeTinybar: bigint): Promise<string> {
    return (await this.post<{ tx: string }>("dispute", { slashId, challenge: challengeTinybar.toString() })).tx;
  }

  async resolveDispute(slashId: Hex, upheld: boolean, signatures: Hex[]): Promise<Settlement> {
    return devnetSettlement(await this.post("resolve", { slashId, upheld, signatures }));
  }

  async executeSlash(slashId: Hex): Promise<Settlement> {
    return devnetSettlement(await this.post("execute", { slashId }));
  }

  async drawSeed(tag: Hex): Promise<SeedDraw> {
    return this.post<SeedDraw>("seed", { tag });
  }

  async seedOf(tag: Hex): Promise<SeedDraw | undefined> {
    const s = await this.get<{ seed: Hex | null; drawnAt: number; tx?: string }>(`seeds/${tag.toLowerCase()}`);
    return s.seed ? { seed: s.seed, drawnAt: s.drawnAt, ...(s.tx ? { tx: s.tx } : {}) } : undefined;
  }
}

function devnetSettlement(s: unknown): Settlement {
  const x = s as Record<string, string>;
  return { tx: x.tx, status: x.status as Settlement["status"], refundTinybar: BigInt(x.refund), burnedTinybar: BigInt(x.burned), challengeTinybar: BigInt(x.challenge) };
}
