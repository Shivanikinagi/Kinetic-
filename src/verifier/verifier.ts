import { PASSPORT_KIND, passportBody, passportDigest, signerOf, signPassport, type Attestation, type Passport, type PassportBody } from "../agent/passport.js";
import { ensureAgent, Erc8004, type Registration } from "../integrations/erc8004.js";
import { agreementHash, agreementProblems, taskHash, type Agreement, type GoldItem } from "../core/agreement.js";
import { planCanaries, type CanaryPlan } from "../core/canary.js";
import { CHUNK_LEAF, chunkLeaves, MERKLE_ANCHOR_SCHEMA, merkleRoot } from "../core/merkle.js";
import { spotCandidates, spotPicks, spotTag } from "../core/spot.js";
import { buildProbes, judgeFingerprint, modelOf, type FingerprintItem, type FingerprintResult, type FingerprintSet } from "../core/fingerprint.js";
import { loadProbeItems } from "../models/review.js";
import { defaultModelRunner, type ModelRunner } from "../models/runner.js";
import { ModelDesk, type ModelReviewer } from "./models.js";
import { agentProfile, uaidFor } from "../integrations/identity.js";
import { CanaryWindow } from "../core/policy.js";
import { attrBig, attrStr, TTL } from "../integrations/arkiv.js";
import type { ReceiptLog } from "../integrations/hcs.js";
import type { Services } from "../integrations/index.js";
import { creditedAmount } from "../integrations/mirror.js";
import { ZeroGClient, type ReferenceRun } from "../integrations/zerog.js";
import type { CanaryTee } from "../integrations/zerog-tee.js";
import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomInt } from "node:crypto";
import { agreement } from "../tasks/compare.js";
import { validateResult } from "../tasks/validate.js";
import { payFetch } from "../integrations/x402.js";
import { summarize } from "../agent/assurance.js";
import { isSettled, type AttestationStatus, type ChunkResponse, type ExecutionCheck, type Item, type ItemOutput, type ResultVerdict, type SlashOutcome, type TaskSpec } from "../types.js";
import { canonicalJson, decryptJson, deriveKey, encryptJson, fromBase64, randomKey, sha256Hex, toBase64 } from "../util/crypto.js";
import { logger } from "../util/log.js";
import { executionHash, recoverResultSigner } from "../util/sign.js";
import { stateFile, writeJsonAtomic } from "../util/state.js";
import { wrapContext, wrapKey } from "../util/wrap.js";
import { resolutionDigest, signDigest, verdictDigest, type SlashVerdict } from "../core/verdict.js";
import type { Settlement } from "../integrations/vault.js";
import { checkExecutionRecord, evidenceOf, type FailureEvidence, type SlashPacket } from "./checks.js";
import { collectQuorum, Cosigner, CosignRefused, type SlashReviewer } from "./cosigner.js";
import type { Hex } from "viem";
import { guaranteeOf } from "../agent/assurance.js";
import { TIER_RULES, type Tier } from "../core/tiers.js";
import { admissionPool, goldFits, goldFor, loadGold, loadGoldSets, plant, plantingPool, scoreKnown, truthOf, type GoldSet, type KnownPlan } from "./known.js";

export interface JobRegistration {
  jobId: string;
  /** Buyer EVM address: Arkiv owner of the job and the refund recipient. */
  buyer: string;
  task: TaskSpec;
  /**
   * Each chunk's items, AES-256-GCM sealed under its chunk key (base64). itemIds lets the verifier
   * format-check every result without opening the chunk.
   */
  chunks: { idx: number; data: string; itemIds?: string[] }[];
  /** Base64 job master key, so the verifier can open canary chunks for 0G reference runs. */
  jobKey: string;
  /** The rules the buyer set for this job. Committed on HCS by hash before any chunk runs. */
  agreement?: Agreement;
  /** The buyer's own labelled examples for admission probes, when the agreement names them. */
  goldSet?: GoldItem[];
  /** The listed model the job runs: its key and the digest of the Model Passport the buyer checked. */
  model?: { key: string; passport: string };
  /**
   * The buyer's own 0G API key (sk-…), when its user signed in with 0G: this job's 0G reference
   * checks are billed to that account instead of the verifier's. Kept in memory only.
   */
  zerogKey?: string;
}

/** A job's model, as the verifier's own listing has it. Its royalty terms are fixed by the passport. */
export interface JobModel {
  key: string;
  id: string;
  version: string;
  passport: string;
  passportRef: string;
  royaltyBps: number;
  payTo: string;
}

/** The creator's royalty for a job, once the buyer paid it. Tinybar. */
export interface JobRoyalty {
  amount: bigint;
  basis: bigint;
  chunks: number;
  tx: string;
}

export interface ResultSubmission {
  response: ChunkResponse;
  payment: { tx: string; amountTinybar: string; payTo: string };
  /** Buyer-measured time for the paid request, for the provider's latency record. */
  latencyMs?: number;
}

export interface QualifyRequest {
  provider: string;
  endpoint: string;
  payTo: string;
  task: TaskSpec;
  /** The job this admission is for, so its agreed examples and accuracy bar apply. */
  jobId?: string;
  /** The listed model the provider is admitted for (its key): the probes run on that model. */
  model?: string;
}

/** Admission check before a provider gets paid work: a probe chunk of known-answer items. */
export interface Qualification {
  provider: string;
  admitted: boolean;
  /** Share of known answers matched, 0..1. */
  agreement: number;
  formatOk: boolean;
  latencyMs: number;
  payTx?: string;
  reason?: string;
  checkedAt: number;
  /** True when no known-answer set exists for the task, so the provider is admitted unchecked. */
  skipped?: boolean;
  /** Whether it answers like the model it declares (absent when there are no fingerprints for that model). */
  fingerprint?: FingerprintResult & { payTx?: string; reason?: string };
}

interface ProviderState {
  name?: string;
  /** HCS-14 UAID from the provider's offer. */
  uaid?: string;
  gpu?: string;
  /** How it cheats, if its offer declares it an adversarial test provider. */
  adversarial?: string;
  /** The backend its offer declares, e.g. "0g:0gm-1.0-35b-a3b". */
  backend?: string;
  /** The 0G Compute provider its offer says it runs on, lower-case. */
  zgProvider?: string;
  /** Its public key for wrapped chunk keys, from its offer. */
  encKey?: string;
  latencies: number[];
  /** The latest admission result, whatever its task (shown on the reputation). */
  qualification?: Qualification;
  /** Admission per task (by task hash): passing one task's probe admits nothing else. */
  qualifications: Map<string, Qualification>;
  window: CanaryWindow;
  pass: number;
  fail: number;
  slashed: boolean;
  payTo?: string;
  reputationKey?: string;
  /** Its ERC-8004 agent id on 0G Chain, from its offer. */
  erc8004?: number;
}

interface JobState {
  reg: JobRegistration;
  plan: CanaryPlan;
  canaries: Set<number>;
  references: Map<number, Promise<ReferenceRun>>;
  /** Reference runs that finished, kept so a restart doesn't pay 0G for them again. */
  resolved: Map<number, ReferenceRun>;
  paid: Map<string, bigint>;
  payments: Set<string>;
  /** Chunks accepted as final: who produced each, the result hash it signed, and its payment (and what it credited). */
  accepted: Map<number, Accepted>;
  slashes: SlashOutcome[];
  canaryReceipts: Map<string, number[]>;
  /** Expected vs actual for every scored canary, for the dashboard's verification view. */
  canaryResults: CanaryResult[];
  fee?: { amountTinybar: bigint; tx: string };
  finalized: boolean;
  agreement?: Agreement;
  agreementHash?: string;
  /** Pass mark for a checked chunk in this job: the agreement's, never below the protocol's. */
  passMark: number;
  gold?: GoldItem[];
  /** Admission results on this job's own examples. */
  qualifications: Map<string, Qualification>;
  /** Every failed check per provider, with the signed result it failed on: the slash evidence. */
  failures: Map<string, FailureEvidence[]>;
  /** The x402 payments each provider received in this job. */
  providerPayments: Map<string, string[]>;
  /** What each slash was signed on, kept to re-check it if the provider disputes. By slash id. */
  packets: Map<string, SlashPacket>;
  /** Providers whose slash the quorum refused, and how many failures it was refused on. */
  refused: Map<string, number>;
  /** Disputed slashes the verifiers already voted on without reaching a decision. */
  reviewed: Set<string>;
  /** Where known answers were planted (absent when the verifier has none for the task). */
  known?: KnownPlan;
  /** The true output for each planted id. Secret: kept on the verifier only. */
  knownTruth: Map<string, ItemOutput>;
  knownResults: KnownResult[];
  tier: Tier;
  /** High assurance: every accepted copy of a chunk so far, before two of them agree. */
  copies: Map<number, Copy[]>;
  redundancy: RedundancyResult[];
  model?: JobModel;
  royalty?: JobRoyalty;
  /** Spot checks committed in the job receipt (core/spot.ts), and the buyer's-items output of each finished chunk they may re-check. */
  spotChecks?: number;
  outputs: Map<number, ItemOutput[]>;
  spot?: JobSpot;
  /** The HCS Merkle anchor over the finished chunks, posted at finalize. */
  anchor?: JobAnchor;
  /** Digest of the passport body this verifier co-signed. */
  attested?: string;
  /** The Compute Passport this verifier stored on 0G Storage for the buyer. */
  passport?: { ref: string; digest: string };
}

/** One `hcs.merkleRootAnchor` per job (core/merkle.ts): the root over its finished chunks, and where it is on HCS. */
export interface JobAnchor {
  schema: typeof MERKLE_ANCHOR_SCHEMA;
  hashAlg: "sha256";
  leaf: typeof CHUNK_LEAF;
  merkleRoot: string;
  recordCount: number;
  hcsSequence: number;
  tx?: string;
}

/** A finished chunk re-run on 0G after the job closed. No agreement when it couldn't be scored. */
export interface SpotCheck {
  idx: number;
  provider: string;
  agreement?: number;
  pass?: boolean;
  zeroGRequest?: string;
  model?: string;
}

/** The job's PRNG seed (drawn in the vault after the reveal), the chunks it picked, and how they did. */
export interface JobSpot {
  tag: string;
  seed: string;
  drawnAt: number;
  seedTx?: string;
  picks: number[];
  checked: SpotCheck[];
  hcsSequence: number;
}

type Accepted = { provider: string; resultHash: string; payTx: string; attestation?: AttestationStatus; amount?: string };

/** One provider's accepted run of a chunk, kept until enough independent copies agree. */
interface Copy {
  provider: string;
  resultHash: string;
  payTx: string;
  attestation?: AttestationStatus;
  amount?: string;
  /** Its answers to the buyer's own items (planted known answers left out). */
  items: ItemOutput[];
}

/** Two independent copies of a chunk that agreed, and any copies outvoted by them. */
export interface RedundancyResult {
  idx: number;
  /** The copy that was kept, then the one that agreed with it. */
  providers: [string, string];
  agreement: number;
  outvoted: string[];
}

/** One chunk scored against the known answers planted in it. */
export interface KnownResult {
  idx: number;
  provider: string;
  items: number;
  correct: number;
  pass: boolean;
}

export interface CanaryResult {
  idx: number;
  provider: string;
  agreement: number;
  pass: boolean;
  requestId: string;
  model: string;
  zeroGProvider: string;
  /** Labels only (no input text): the 0G reference and the provider's answer. */
  expected: ItemOutput[];
  actual: ItemOutput[];
  /** Our own check of the reference run's TEE signature: provider, chat id, signed text, signer, cost. */
  tee?: CanaryTee;
}

/**
 * A job as saved on the verifier's disk, so a restart mid-job can still judge the remaining
 * chunks and reveal the canary set it committed to. It holds the job key and the salt, so it
 * stays local: never on Arkiv or in storage.
 */
interface SavedJob {
  v: 1;
  reg: JobRegistration;
  plan: CanaryPlan;
  references: Record<string, ReferenceRun>;
  paid: Record<string, string>;
  payments: string[];
  accepted: Record<string, Accepted>;
  slashes: (Omit<SlashOutcome, "refundTinybar" | "burnedTinybar"> & { refundTinybar: string; burnedTinybar?: string })[];
  canaryReceipts: Record<string, number[]>;
  canaryResults: CanaryResult[];
  fee?: { amountTinybar: string; tx: string };
  finalized: boolean;
  agreement?: Agreement;
  agreementHash?: string;
  passMark: number;
  gold?: GoldItem[];
  qualifications: Record<string, Qualification>;
  failures?: Record<string, FailureEvidence[]>;
  providerPayments?: Record<string, string[]>;
  packets?: Record<string, SlashPacket>;
  refused?: Record<string, number>;
  reviewed?: string[];
  known?: KnownPlan;
  knownTruth?: Record<string, ItemOutput>;
  knownResults?: KnownResult[];
  tier?: Tier;
  copies?: Record<string, Copy[]>;
  redundancy?: RedundancyResult[];
  model?: JobModel;
  royalty?: Omit<JobRoyalty, "amount" | "basis"> & { amount: string; basis: string };
  spotChecks?: number;
  outputs?: Record<string, ItemOutput[]>;
  spot?: JobSpot;
  anchor?: JobAnchor;
  attested?: string;
  passport?: { ref: string; digest: string };
}

function toSaved(job: JobState): SavedJob {
  return {
    v: 1,
    reg: job.reg,
    plan: job.plan,
    references: Object.fromEntries(job.resolved),
    paid: Object.fromEntries([...job.paid].map(([p, amount]) => [p, amount.toString()])),
    payments: [...job.payments],
    accepted: Object.fromEntries(job.accepted),
    slashes: job.slashes.map((s) => ({ ...s, refundTinybar: s.refundTinybar.toString(), burnedTinybar: s.burnedTinybar?.toString() })),
    canaryReceipts: Object.fromEntries(job.canaryReceipts),
    canaryResults: job.canaryResults,
    fee: job.fee && { amountTinybar: job.fee.amountTinybar.toString(), tx: job.fee.tx },
    finalized: job.finalized,
    agreement: job.agreement,
    agreementHash: job.agreementHash,
    passMark: job.passMark,
    gold: job.gold,
    qualifications: Object.fromEntries(job.qualifications),
    failures: Object.fromEntries(job.failures),
    providerPayments: Object.fromEntries(job.providerPayments),
    packets: Object.fromEntries(job.packets),
    refused: Object.fromEntries(job.refused),
    reviewed: [...job.reviewed],
    known: job.known,
    knownTruth: Object.fromEntries(job.knownTruth),
    knownResults: job.knownResults,
    tier: job.tier,
    copies: Object.fromEntries(job.copies),
    redundancy: job.redundancy,
    ...(job.model ? { model: job.model } : {}),
    ...(job.royalty ? { royalty: { ...job.royalty, amount: job.royalty.amount.toString(), basis: job.royalty.basis.toString() } } : {}),
    ...(job.spotChecks ? { spotChecks: job.spotChecks, outputs: Object.fromEntries(job.outputs) } : {}),
    ...(job.spot ? { spot: job.spot } : {}),
    ...(job.anchor ? { anchor: job.anchor } : {}),
    ...(job.attested ? { attested: job.attested } : {}),
    ...(job.passport ? { passport: job.passport } : {}),
  };
}

function fromSaved(s: SavedJob): JobState {
  const resolved = new Map(Object.entries(s.references).map(([idx, run]) => [Number(idx), run]));
  return {
    reg: s.reg,
    plan: s.plan,
    canaries: new Set(s.plan.indices),
    references: new Map([...resolved].map(([idx, run]) => [idx, Promise.resolve(run)])),
    resolved,
    paid: new Map(Object.entries(s.paid).map(([p, amount]) => [p, BigInt(amount)])),
    payments: new Set(s.payments),
    accepted: new Map(Object.entries(s.accepted).map(([idx, a]) => [Number(idx), a])),
    slashes: s.slashes.map((x) => ({ ...x, refundTinybar: BigInt(x.refundTinybar), burnedTinybar: x.burnedTinybar === undefined ? undefined : BigInt(x.burnedTinybar) })),
    canaryReceipts: new Map(Object.entries(s.canaryReceipts)),
    canaryResults: s.canaryResults,
    fee: s.fee && { amountTinybar: BigInt(s.fee.amountTinybar), tx: s.fee.tx },
    finalized: s.finalized,
    agreement: s.agreement,
    agreementHash: s.agreementHash,
    passMark: s.passMark,
    gold: s.gold,
    qualifications: new Map(Object.entries(s.qualifications)),
    failures: new Map(Object.entries(s.failures ?? {})),
    providerPayments: new Map(Object.entries(s.providerPayments ?? {})),
    packets: new Map(Object.entries(s.packets ?? {})),
    refused: new Map(Object.entries(s.refused ?? {})),
    reviewed: new Set(s.reviewed ?? []),
    known: s.known,
    knownTruth: new Map(Object.entries(s.knownTruth ?? {})),
    knownResults: s.knownResults ?? [],
    tier: s.tier ?? "standard",
    copies: new Map(Object.entries(s.copies ?? {}).map(([idx, c]) => [Number(idx), c])),
    redundancy: s.redundancy ?? [],
    ...(s.model ? { model: s.model } : {}),
    ...(s.royalty ? { royalty: { ...s.royalty, amount: BigInt(s.royalty.amount), basis: BigInt(s.royalty.basis) } } : {}),
    ...(s.spotChecks ? { spotChecks: s.spotChecks } : {}),
    outputs: new Map(Object.entries(s.outputs ?? {}).map(([idx, items]) => [Number(idx), items])),
    ...(s.spot ? { spot: s.spot } : {}),
    ...(s.anchor ? { anchor: s.anchor } : {}),
    ...(s.attested ? { attested: s.attested } : {}),
    ...(s.passport ? { passport: s.passport } : {}),
  };
}

/** How long a spot check waits for its 0G reference run before it is left unscored. */
const SPOT_REFERENCE_TIMEOUT_MS = 90_000;

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });

/** How long after its expiry second the settle loop leaves a slash to the vault's own scheduled call. */
const SCHEDULED_GRACE_SECONDS = 15;

export class VerifierError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Serialises async work per key, so two results for one provider cannot race a slash. */
class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.tails.get(key) ?? Promise.resolve()).then(fn, fn);
    this.tails.set(key, next.catch(() => undefined));
    return next;
  }
}

export class Verifier {
  private readonly jobs = new Map<string, JobState>();
  /** 0G clients on buyers' own accounts, per job (from JobRegistration.zerogKey). Never saved. */
  private readonly payers = new Map<string, ZeroGClient>();
  private readonly providers = new Map<string, ProviderState>();
  /** 0G chat ids already credited to a result, and when, so one 0G run can't back two. Saved to disk. */
  private readonly seenChats = new Map<string, number>();
  private readonly lock = new KeyedLock();
  private readonly log = logger("verifier");
  private referenceSlots = 2;
  private earnedTinybar = 0n;
  private feePayments = 0;
  private readonly referenceWaiters: (() => void)[] = [];
  private readonly qualifying = new Map<string, Promise<Qualification>>();
  /** Per task: labelled examples for admission probes, and the other half, planted in jobs as known answers. */
  private readonly admission: GoldSet[];
  private readonly planting: GoldSet[];
  /** The task the model fingerprints were measured on (the ticket set). */
  private readonly fingerprintTask: TaskSpec | null;
  /** Measured model fingerprints (npm run fingerprint); null when there are none. */
  private readonly fingerprints: FingerprintSet | null;

  /** This verifier's own independent re-check, its vote when a slash is disputed. */
  private readonly reviewer: Cosigner;
  /** Model Passports and the listings in the model registry. */
  readonly models: ModelDesk;
  /** Fingerprint probe items (borderline tickets), by id. */
  private readonly probeTexts: Record<string, string>;
  private settleTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly svc: Services,
    private readonly zerog: ZeroGClient,
    private readonly receipts: ReceiptLog,
    goldPaths = { task: process.env.GOLD_TASK || "data/classify-tickets.task.json", items: process.env.GOLD_SET || "data/gold-tickets.jsonl" },
    /** The vault's other verifiers, asked to co-sign every slash and every Model Passport. */
    private readonly cosigners: SlashReviewer[] = [],
    opts: { modelRunner?: ModelRunner } = {},
  ) {
    const tickets = loadGold(goldPaths);
    const sets = [...(tickets ? [tickets] : []), ...loadGoldSets().filter((s) => !tickets || !goldFits(s, tickets.task))];
    // Two disjoint halves per task: admission probes show a provider whole chunks of known
    // answers, so they never use the items that get planted in jobs.
    this.admission = sets.map(admissionPool);
    this.planting = sets.map(plantingPool);
    this.fingerprintTask = tickets?.task ?? null;
    this.reviewer = new Cosigner({ cfg: svc.cfg, account: svc.account, zerog, arkiv: svc.arkiv, vault: svc.vault, gold: this.planting });
    try {
      this.fingerprints = JSON.parse(readFileSync(process.env.FINGERPRINTS || "data/fingerprints.json", "utf8"));
    } catch {
      this.fingerprints = null;
    }
    const probeItems = loadProbeItems();
    this.probeTexts = Object.fromEntries(probeItems.map((i) => [i.id, i.text]));
    const { models } = svc.cfg;
    this.models = new ModelDesk({
      svc,
      receipts,
      review: {
        runner: opts.modelRunner ?? defaultModelRunner(zerog),
        gold: this.planting,
        probes: this.fingerprintTask ? { task: this.fingerprintTask, items: probeItems } : null,
        minAccuracy: models.minAccuracy,
        benchmarkItems: models.benchmarkItems,
        maxDownloadBytes: models.maxDownloadBytes,
      },
      // The other verifiers re-review every model on their own before they sign its passport.
      reviewers: cosigners.filter((c): c is SlashReviewer & ModelReviewer => "attestModel" in c),
    });
    this.restoreJobs();
    this.restoreChats();
  }

  /** Where the used 0G chat ids are kept, so a restart doesn't reopen replays. */
  private get chatsFile(): string | undefined {
    return stateFile(this.svc.cfg, `verifier-${this.svc.address}`, "zg-chats.json");
  }

  private restoreChats(): void {
    const file = this.chatsFile;
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
      for (const [key, at] of Object.entries(saved)) this.seenChats.set(key, at);
    } catch {
      // No file yet.
    }
  }

  /** Records a chat id as used, on disk before the result it backs is accepted. */
  private useChat(key: string): void {
    this.seenChats.set(key, Date.now());
    const file = this.chatsFile;
    if (!file) return;
    // A 0G provider's signature is only served for a while; older chat ids can't be replayed anyway.
    const horizon = Date.now() - 90 * 24 * 3600_000;
    for (const [k, at] of this.seenChats) if (at < horizon) this.seenChats.delete(k);
    writeJsonAtomic(file, Object.fromEntries(this.seenChats));
  }

  /** Directory of saved jobs, or undefined when this verifier keeps no state on disk. */
  private get jobDir(): string | undefined {
    return stateFile(this.svc.cfg, `verifier-${this.svc.address}`, "jobs");
  }

  // Named by a hash of the job id: the id comes from the buyer and must never become a path.
  private jobFile(jobId: string): string | undefined {
    const dir = this.jobDir;
    return dir && join(dir, `${sha256Hex(jobId).slice(0, 32)}.json`);
  }

  private save(job: JobState): void {
    const file = this.jobFile(job.reg.jobId);
    if (!file) return;
    try {
      writeJsonAtomic(file, toSaved(job));
    } catch (err) {
      this.log(`could not save job ${job.reg.jobId}`, { error: (err as Error).message });
    }
  }

  /** Picks up the jobs a previous run of this verifier left open, and their fees. */
  private restoreJobs(): void {
    const dir = this.jobDir;
    if (!dir) return;
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    for (const f of files) {
      const path = join(dir, f);
      try {
        const job = fromSaved(JSON.parse(readFileSync(path, "utf8")) as SavedJob);
        // A job registered before chunks travelled inline (in the request itself) can't be checked any more.
        if (!job.finalized && job.reg.chunks.some((c) => !c.data)) {
          this.log(`skipping saved job ${job.reg.jobId}: its chunks predate inline delivery`);
          continue;
        }
        // Finished jobs are kept as long as their Arkiv job entity, for late attestations.
        if (job.finalized && Date.now() - statSync(path).mtimeMs > TTL.job * 1000) {
          unlinkSync(path);
          continue;
        }
        this.jobs.set(job.reg.jobId, job);
        if (!job.finalized) for (const idx of job.plan.indices) if (!job.resolved.has(idx)) this.startReference(job, idx);
        if (job.fee) {
          this.earnedTinybar += job.fee.amountTinybar;
          this.feePayments += 1;
        }
      } catch (err) {
        this.log(`skipping saved job ${f}`, { error: (err as Error).message });
      }
    }
    if (this.jobs.size > 0) this.log(`restored ${this.jobs.size} saved job(s)`);
  }

  /** The 0G account that pays this job's reference checks: the buyer's own when it gave a key. */
  private zerogFor(job: JobState): ZeroGClient {
    return this.payers.get(job.reg.jobId) ?? this.zerog;
  }

  /** Starts the 0G reference run for one canary chunk. */
  private startReference(job: JobState, idx: number): void {
    const data = job.reg.chunks.find((c) => c.idx === idx)!.data;
    const jobKey = fromBase64(job.reg.jobKey);
    const run = this.withReferenceSlot(async () => {
      const items = decryptJson<Item[]>(deriveKey(jobKey, `chunk:${idx}`), fromBase64(data));
      return this.zerogFor(job).reference(job.reg.task, items);
    });
    run.then(
      (r) => {
        job.resolved.set(idx, r);
        this.save(job);
      },
      (err) => this.log(`0G reference for ${job.reg.jobId}#${idx} failed`, { error: (err as Error).message }),
    );
    job.references.set(idx, run);
  }

  /** Forgets a job whose fee never settled, so it can't be used without paying. */
  dropJob(jobId: string): void {
    this.payers.delete(jobId);
    if (!this.jobs.delete(jobId)) return;
    const file = this.jobFile(jobId);
    if (file) {
      try {
        unlinkSync(file);
      } catch {
        // Never saved.
      }
    }
    this.log(`dropped job ${jobId}: its verification fee did not settle`);
  }

  get address() {
    return this.svc.address;
  }

  async registerJob(reg: JobRegistration): Promise<{ commitment: string; canaries: number; known?: string; chunks?: JobRegistration["chunks"] }> {
    if (this.jobs.has(reg.jobId)) throw new VerifierError(409, "job already registered");
    const { canaryRate: protocolRate, minCanaries, minAgreement } = this.svc.cfg.policy;
    if (reg.agreement) {
      const problems = agreementProblems(reg.agreement, reg.task, { canaryRate: protocolRate, minAgreement }, reg.goldSet);
      if (problems.length > 0) throw new VerifierError(400, `agreement rejected: ${problems.join("; ")}`);
    }
    if (reg.zerogKey !== undefined && !/^sk-[A-Za-z0-9_-]{16,}$/.test(reg.zerogKey)) throw new VerifierError(400, "zerogKey must be a 0G API key (sk-…)");
    const model = reg.model ? this.jobModel(reg) : undefined;
    const tier = reg.agreement?.tier ?? "standard";
    const rules = TIER_RULES[tier];
    const plan = rules.canaries ? planCanaries(reg.jobId, reg.chunks.length, reg.agreement?.canaryRate ?? protocolRate, minCanaries) : planCanaries(reg.jobId, reg.chunks.length, 0, 0);
    const hash = reg.agreement ? agreementHash(reg.agreement) : undefined;
    // Ground truth: one known-answer item planted in every chunk, re-encrypted under the
    // chunk's own key. The buyer gets the new references; only this verifier knows the answers.
    const pool = goldFor(this.planting, reg.task);
    const planted = rules.knownAnswers && this.svc.cfg.policy.plantKnown && pool ? await this.plantKnown(reg, pool) : undefined;
    const job: JobState = {
      reg: { ...reg, buyer: reg.buyer.toLowerCase(), goldSet: undefined, zerogKey: undefined, ...(planted ? { chunks: planted.chunks } : {}) },
      agreement: reg.agreement,
      agreementHash: hash,
      passMark: reg.agreement?.minAgreement ?? minAgreement,
      gold: reg.agreement?.admission.source === "buyer" ? reg.goldSet : undefined,
      qualifications: new Map(),
      plan,
      canaries: new Set(plan.indices),
      references: new Map(),
      resolved: new Map(),
      paid: new Map(),
      payments: new Set(),
      accepted: new Map(),
      slashes: [],
      canaryReceipts: new Map(),
      canaryResults: [],
      finalized: false,
      failures: new Map(),
      providerPayments: new Map(),
      packets: new Map(),
      refused: new Map(),
      reviewed: new Set(),
      known: planted?.plan,
      knownTruth: planted?.truth ?? new Map(),
      knownResults: [],
      tier,
      copies: new Map(),
      redundancy: [],
      ...(model ? { model } : {}),
      ...(this.svc.cfg.policy.spotChecks > 0 && this.svc.vault.drawSeed ? { spotChecks: this.svc.cfg.policy.spotChecks } : {}),
      outputs: new Map(),
    };
    this.jobs.set(reg.jobId, job);
    if (reg.zerogKey) {
      this.payers.set(reg.jobId, new ZeroGClient({ ...this.svc.cfg.zerog, apiKey: reg.zerogKey }));
      this.log(`${reg.jobId}: 0G reference checks billed to the buyer's own 0G account`);
    }
    this.save(job);

    // Commit to the canary set (revealed at finalize) and to the agreed rules, before any chunk runs.
    await this.receipts.submit({
      t: "job",
      job: reg.jobId,
      buyer: job.reg.buyer,
      chunks: reg.chunks.length,
      task: reg.task.kind,
      commitment: plan.commitment,
      ...(hash ? { agreement: hash } : {}),
      ...(planted ? { known: planted.plan.commitment } : {}),
      ...(model ? { model: model.key } : {}),
      // How many chunks a PRNG seed drawn after the reveal will pick for re-checking: fixed now.
      ...(job.spotChecks ? { spot: job.spotChecks } : {}),
    });

    for (const idx of plan.indices) this.startReference(job, idx);
    this.log(`job ${reg.jobId} registered`, { chunks: reg.chunks.length, canaries: plan.indices.length, known: planted ? "planted in every chunk" : "none for this task", commitment: plan.commitment });
    return { commitment: plan.commitment, canaries: plan.indices.length, ...(planted ? { known: planted.plan.commitment, chunks: planted.chunks } : {}) };
  }

  /**
   * The model a job asks for, from this verifier's own listing: it must be listed here, be the
   * passport the buyer checked, do the job's task, and the agreement must carry its exact
   * royalty terms (so they are committed on HCS with the rest of the rules).
   */
  private jobModel(reg: JobRegistration): JobModel {
    const listing = this.models.get(String(reg.model?.key ?? ""));
    if (!listing) throw new VerifierError(400, `model ${reg.model?.key} isn't listed by this verifier`);
    if (listing.passportDigest !== reg.model!.passport) throw new VerifierError(400, "the job names a different Model Passport than the one listed");
    if (taskHash(listing.card.task) !== taskHash(reg.task)) throw new VerifierError(400, "the job's task isn't the model's task");
    const model: JobModel = {
      key: listing.key,
      id: listing.card.id,
      version: listing.card.version,
      passport: listing.passportDigest,
      passportRef: listing.passportRef,
      royaltyBps: listing.card.royaltyBps,
      payTo: listing.card.creator.payTo,
    };
    const agreed = reg.agreement?.model;
    if (reg.agreement && (!agreed || canonicalJson(agreed) !== canonicalJson(model))) throw new VerifierError(400, "the agreement must carry the model's listed terms");
    return model;
  }

  /** Opens every chunk, plants a known answer in it, and seals it again under the same chunk key. */
  private async plantKnown(reg: JobRegistration, pool: GoldSet): Promise<{ chunks: JobRegistration["chunks"]; truth: Map<string, ItemOutput>; plan: KnownPlan }> {
    const jobKey = fromBase64(reg.jobKey);
    const opened = await Promise.all(
      reg.chunks.map(async (c) => ({ idx: c.idx, items: decryptJson<Item[]>(deriveKey(jobKey, `chunk:${c.idx}`), fromBase64(c.data)) })),
    );
    const { chunks, truth, plan } = plant(reg.jobId, reg.task, pool, opened);
    const sealed = chunks.map((c) => ({ idx: c.idx, data: toBase64(encryptJson(deriveKey(jobKey, `chunk:${c.idx}`), c.items)), itemIds: c.items.map((i) => i.id) }));
    return { chunks: sealed, truth, plan };
  }

  async submit(jobId: string, buyer: string, sub: ResultSubmission): Promise<ResultVerdict> {
    const job = this.jobs.get(jobId);
    if (!job) throw new VerifierError(404, "unknown job");
    if (job.reg.buyer !== buyer.toLowerCase()) throw new VerifierError(403, "not this job's buyer");
    if (job.finalized) throw new VerifierError(409, "job finalized");
    const { response, payment } = sub;
    const provider = response.provider.toLowerCase();
    return this.lock.run(provider, async () => {
      try {
        return await this.judge(job, provider, response, payment, sub.latencyMs);
      } finally {
        this.save(job);
      }
    });
  }

  private async judge(job: JobState, provider: string, response: ChunkResponse, payment: ResultSubmission["payment"], latencyMs?: number): Promise<ResultVerdict> {
    const state = await this.providerState(provider);
    const summary = () => ({ status: state.slashed ? ("slashed" as const) : ("ok" as const), failures: state.window.failures, window: state.window.size });
    const reject = (reason: string): ResultVerdict => ({ verdict: "rejected", reason, provider: summary() });

    if (response.jobId !== job.reg.jobId || response.idx < 0 || response.idx >= job.reg.chunks.length) return reject("wrong job or chunk");
    if (sha256Hex(canonicalJson(response.result)) !== response.resultHash) return reject("result hash mismatch");
    const signer = await recoverResultSigner(response.jobId, response.idx, response.resultHash, response.signature as `0x${string}`, executionHash(response.execution), response.model);
    if (signer !== provider) return reject("signature does not match provider");
    if (state.slashed) return reject("provider is slashed");

    // Payment: trust the mirror node, not the buyer's claim. Sized by what actually reached the provider.
    if (!state.payTo || payment.payTo.toLowerCase() !== state.payTo.toLowerCase()) return reject("payment went to an account that is not this provider's");
    if (job.payments.has(payment.tx)) return reject("payment already counted");
    const credited = await creditedAmount(this.svc.cfg.hedera.mirrorUrl, payment.tx, state.payTo);
    if (credited <= 0n) return reject("payment not found on the mirror node");
    job.payments.add(payment.tx);
    job.paid.set(provider, (job.paid.get(provider) ?? 0n) + credited);
    job.providerPayments.set(provider, [...(job.providerPayments.get(provider) ?? []), payment.tx]);
    const failed = (kind: FailureEvidence["kind"]) => job.failures.set(provider, [...(job.failures.get(provider) ?? []), { kind, idx: response.idx, response, payTx: payment.tx }]);
    // A model job: the provider must have signed for the job's model. Its payment still counts
    // above, so a later slash refunds it.
    if (job.model && response.model !== job.model.key) return reject("signed for a different model than the job's");

    // Where it ran: checked here against the 0G chain and the 0G provider, not taken from the provider.
    const exec = await this.checkExecution(job, state, response);
    const e = exec.execution;
    const chunkReceipt = await this.receipts.submit({
      t: "chunk",
      job: job.reg.jobId,
      idx: response.idx,
      provider,
      resultHash: response.resultHash,
      payTx: payment.tx,
      amount: credited.toString(),
      ...(e
        ? {
            zg: e.zgProvider,
            chat: e.chatId,
            m: e.model.slice(0, 64),
            pt: e.providerType,
            ...(e.providerIdentity ? { pid: e.providerIdentity.slice(0, 32) } : {}),
            att: e.attestation,
            ...(e.reason ? { why: e.reason.slice(0, 120) } : {}),
          }
        : {}),
    });
    const execution = exec.execution;
    if (exec.problem) {
      // Claiming 0G work it can't back up counts as a failed check, like a malformed result.
      state.window.record(false);
      state.fail += 1;
      failed("execution");
      this.recordCheck(provider, job.reg.jobId, response.idx, "execution", false);
      const seqs = job.canaryReceipts.get(provider) ?? [];
      seqs.push(chunkReceipt.sequence);
      job.canaryReceipts.set(provider, seqs);
      this.log(`0G execution rejected ${job.reg.jobId}#${response.idx}`, { provider, problem: exec.problem });
      const slash = state.window.breached && !state.slashed ? await this.slash(job, provider, state, response) : undefined;
      await this.writeReputation(provider, state);
      return { verdict: "rejected", reason: exec.problem, provider: summary(), slash, ...(execution ? { execution } : {}) };
    }
    if (TIER_RULES[job.tier].attested) {
      const e = execution;
      const why = !e
        ? "confidential assurance needs a run on a named 0G Compute service"
        : e.attestation !== "verified"
          ? `confidential assurance needs a verified TEE attestation; this run's is ${e.attestation}`
          : guaranteeOf(e.verifiability, e.providerType) !== "TeeML"
            ? `confidential assurance needs TeeML on a 0G node; this run is ${guaranteeOf(e.verifiability, e.providerType)}`
            : undefined;
      // Not cheating, just not this tier: rejected without counting against the provider.
      if (why) return { verdict: "rejected", reason: why, provider: summary(), ...(e ? { execution: e } : {}) };
    }
    if (latencyMs && latencyMs > 0) {
      state.latencies.push(latencyMs);
      if (state.latencies.length > 20) state.latencies.shift();
    }

    // Format check on every chunk. Malformed output is rejected and counts as a failed check.
    const itemIds = job.reg.chunks.find((c) => c.idx === response.idx)?.itemIds;
    if (itemIds) {
      const problems = validateResult(job.reg.task, itemIds.map((id) => ({ id, text: "" })), response.result);
      if (problems.length > 0) {
        state.window.record(false);
        state.fail += 1;
        failed("format");
        this.recordCheck(provider, job.reg.jobId, response.idx, "format", false);
        await this.receipts.submit({ t: "format", job: job.reg.jobId, idx: response.idx, provider, problems: problems.slice(0, 3) });
        const seqs = job.canaryReceipts.get(provider) ?? [];
        seqs.push(chunkReceipt.sequence);
        job.canaryReceipts.set(provider, seqs);
        this.log(`malformed result ${job.reg.jobId}#${response.idx}`, { provider, problems: problems.slice(0, 3) });
        const slash = state.window.breached && !state.slashed ? await this.slash(job, provider, state, response) : undefined;
        await this.writeReputation(provider, state);
        return { verdict: "rejected", reason: `malformed: ${problems.slice(0, 2).join("; ")}`, provider: summary(), slash, ...(execution ? { execution } : {}) };
      }
    }

    // Ground truth: the known answers planted in this chunk. A miss fails the chunk and counts
    // toward slashing; this is the check slashing rests on.
    const plantedIds = job.known?.placements.find((p) => p.idx === response.idx)?.ids ?? [];
    let known: ResultVerdict["known"];
    if (plantedIds.length > 0) {
      known = scoreKnown(job.reg.task, plantedIds.map((id) => job.knownTruth.get(id)!).filter(Boolean), response.result.items);
      state.window.record(known.pass);
      if (known.pass) state.pass += 1;
      else {
        state.fail += 1;
        failed("known");
      }
      this.recordCheck(provider, job.reg.jobId, response.idx, "known", known.pass);
      job.knownResults.push({ idx: response.idx, provider, ...known });
      const knownReceipt = await this.receipts.submit({ t: "known", job: job.reg.jobId, idx: response.idx, provider, ...known });
      const seqs = job.canaryReceipts.get(provider) ?? [];
      seqs.push(chunkReceipt.sequence, knownReceipt.sequence);
      job.canaryReceipts.set(provider, seqs);
      if (!known.pass) {
        this.log(`known answers ${job.reg.jobId}#${response.idx} FAIL`, { provider, correct: `${known.correct}/${known.items}`, failures: `${state.window.failures}/${state.window.size}` });
        const slash = state.window.breached && !state.slashed ? await this.slash(job, provider, state, response) : undefined;
        await this.writeReputation(provider, state);
        return {
          verdict: "canary_fail",
          reason: `missed ${known.items - known.correct} of ${known.items} known answer${known.items === 1 ? "" : "s"}`,
          canary: { agreement: known.correct / known.items, pass: false, kind: "known" },
          known,
          provider: summary(),
          slash,
          ...(execution ? { execution } : {}),
        };
      }
    }

    if (!job.canaries.has(response.idx)) {
      if (known) await this.writeReputation(provider, state);
      const redundancy = await this.accept(job, provider, response, payment.tx, execution, credited);
      return { verdict: "accepted", ...(known ? { known } : {}), ...(redundancy ? { redundancy } : {}), provider: summary(), ...(execution ? { execution } : {}) };
    }

    // Canary: compare with the 0G verified reference run. If 0G could not produce one, the
    // chunk is accepted unscored rather than counting against an honest provider.
    let reference: ReferenceRun;
    try {
      reference = await job.references.get(response.idx)!;
    } catch {
      const redundancy = await this.accept(job, provider, response, payment.tx, execution, credited);
      return { verdict: "accepted", reason: "0G reference unavailable; canary not scored", ...(known ? { known } : {}), ...(redundancy ? { redundancy } : {}), provider: summary(), ...(execution ? { execution } : {}) };
    }
    // Compared on the buyer's own items only: the planted ones were already scored against the truth.
    const planted = new Set(plantedIds);
    const own = (items: ItemOutput[]) => ({ items: items.filter((i) => !planted.has(i.id)) });
    const score = agreement(job.reg.task, own(reference.result.items), own(response.result.items));
    // Two bars. The protocol's decides the provider's record; this job's agreed pass mark (never
    // lower) decides whether the buyer accepts the chunk. Disagreeing with another model isn't
    // proof the answer was wrong (two models can both be reasonable), so it fails the chunk but
    // only counts toward slashing when CANARY_MODEL_SLASHES is set.
    const pass = score >= this.svc.cfg.policy.minAgreement;
    const accepted = score >= job.passMark;
    const counts = this.svc.cfg.policy.modelSlashes;
    if (counts) {
      state.window.record(pass);
      if (pass) state.pass += 1;
      else {
        state.fail += 1;
        failed("canary");
      }
    }
    this.recordCheck(provider, job.reg.jobId, response.idx, "canary", pass);
    const canaryReceipt = await this.receipts.submit({
      t: "canary",
      job: job.reg.jobId,
      idx: response.idx,
      provider,
      agreement: Math.round(score * 1000) / 1000,
      pass,
      accepted,
      ref: reference.requestId,
    });
    job.canaryResults.push({
      idx: response.idx,
      provider,
      agreement: score,
      pass: accepted,
      requestId: reference.requestId,
      model: reference.model,
      zeroGProvider: reference.providerIdentity || reference.provider,
      expected: reference.result.items,
      actual: response.result.items,
      ...(reference.tee ? { tee: reference.tee } : {}),
    });
    const seqs = job.canaryReceipts.get(provider) ?? [];
    seqs.push(...(known ? [] : [chunkReceipt.sequence]), canaryReceipt.sequence);
    job.canaryReceipts.set(provider, seqs);
    const below = pass && !accepted ? "below this job's agreed pass mark" : undefined;
    this.log(`canary ${job.reg.jobId}#${response.idx} ${accepted ? "PASS" : "FAIL"}`, { provider, agreement: score.toFixed(2), failures: `${state.window.failures}/${state.window.size}`, ...(below ? { note: below } : {}) });

    let slash: SlashOutcome | undefined;
    if (counts && state.window.breached && !state.slashed) slash = await this.slash(job, provider, state, response);
    await this.writeReputation(provider, state);
    const redundancy = accepted ? await this.accept(job, provider, response, payment.tx, execution, credited) : undefined;

    return {
      verdict: accepted ? "canary_pass" : "canary_fail",
      ...(below ? { reason: below } : !accepted ? { reason: `disagreed with the 0G reference model (${Math.round(score * 100)}%)` } : {}),
      canary: { agreement: score, pass: accepted, kind: "model" },
      ...(known ? { known } : {}),
      ...(redundancy ? { redundancy } : {}),
      provider: summary(),
      slash,
      ...(execution ? { execution } : {}),
    };
  }

  /**
   * Accepts a chunk result. At high assurance a chunk is final only once two independent
   * providers' copies agree (at this job's pass mark, on the buyer's own items); until then each
   * copy is kept and the buyer is told to run another. The copy kept is the earlier of the two;
   * copies outvoted by them are recorded against their providers, as disagreement, never as a
   * slashing offence.
   */
  private async accept(job: JobState, provider: string, response: ChunkResponse, payTx: string, execution: ExecutionCheck | undefined, credited: bigint): Promise<ResultVerdict["redundancy"]> {
    const entry: Accepted = { provider, resultHash: response.resultHash, payTx, ...(execution ? { attestation: execution.attestation } : {}), amount: credited.toString() };
    const planted = new Set(job.known?.placements.find((p) => p.idx === response.idx)?.ids ?? []);
    if (TIER_RULES[job.tier].copies <= 1) {
      job.accepted.set(response.idx, entry);
      if (job.spotChecks) job.outputs.set(response.idx, response.result.items.filter((i) => !planted.has(i.id)));
      return undefined;
    }
    const mine: Copy = { ...entry, items: response.result.items.filter((i) => !planted.has(i.id)) };
    // A slashed provider's copy no longer counts.
    const copies = [...(job.copies.get(response.idx) ?? []).filter((c) => !this.providers.get(c.provider)?.slashed && c.provider !== provider), mine];
    job.copies.set(response.idx, copies);
    if (copies.length === 1) return { state: "awaiting", copies: 1 };
    const score = (a: Copy, b: Copy) => agreement(job.reg.task, { items: a.items }, { items: b.items });
    const match = copies.slice(0, -1).find((c) => score(c, mine) >= job.passMark);
    if (!match) return { state: copies.length >= 3 ? "unresolved" : "mismatch", copies: copies.length };
    const outvoted = copies.filter((c) => c !== match && c !== mine && score(match, c) < job.passMark).map((c) => c.provider);
    const agreed = Math.round(score(match, mine) * 1000) / 1000;
    const { items: keptItems, ...kept } = match;
    job.accepted.set(response.idx, kept);
    if (job.spotChecks) job.outputs.set(response.idx, keptItems);
    job.redundancy.push({ idx: response.idx, providers: [match.provider, provider], agreement: agreed, outvoted });
    await this.receipts.submit({ t: "redundant", job: job.reg.jobId, idx: response.idx, providers: [match.provider, provider], agreement: agreed, outvoted });
    for (const p of [match.provider, provider]) this.recordCheck(p, job.reg.jobId, response.idx, "redundant", true);
    for (const p of outvoted) this.recordCheck(p, job.reg.jobId, response.idx, "redundant", false);
    return { state: "matched", copies: copies.length, winner: match.provider, agreement: agreed, outvoted };
  }

  /**
   * Slashes a provider that reached the failure limit. The verdict names the job, the chunk and
   * result that tipped it over, and hashes every failed check behind it. This verifier signs
   * it, the vault's other verifiers re-check the evidence on their own and co-sign, and the
   * vault opens the slash only with a quorum of their signatures. It executes once the dispute
   * window closes: right away when the window is zero, otherwise on the settle loop.
   * Returns undefined when the quorum refused.
   */
  private async slash(job: JobState, provider: string, state: ProviderState, trigger: ChunkResponse): Promise<SlashOutcome | undefined> {
    const failures = job.failures.get(provider) ?? [];
    if ((job.refused.get(provider) ?? -1) >= failures.length) return undefined;
    const info = await this.svc.vault.info();
    // Payments and bonds are both HBAR: the buyer gets back exactly what it paid this provider.
    const owed = job.paid.get(provider) ?? 0n;
    const evidence = evidenceOf(this.receipts.topicId, job.reg.jobId, provider, job.canaryReceipts.get(provider) ?? [], failures);
    const verdict: SlashVerdict = { provider, buyer: job.reg.buyer, jobId: job.reg.jobId, chunk: trigger.idx, resultHash: trigger.resultHash, refundTinybar: owed, evidence };
    const packet: SlashPacket = {
      verdict: { ...verdict, refundTinybar: owed.toString() },
      registration: { jobId: job.reg.jobId, buyer: job.reg.buyer, task: job.reg.task, chunks: job.reg.chunks, jobKey: job.reg.jobKey },
      canaries: { indices: job.plan.indices, salt: job.plan.salt },
      ...(job.known ? { known: { placements: job.known.placements, salt: job.known.salt } } : {}),
      failures,
      payments: job.providerPayments.get(provider) ?? [],
      payTo: state.payTo ?? provider,
    };

    const digest = verdictDigest(verdict, info);
    const reasons: string[] = [];
    const votes = await Promise.all(
      this.cosigners.map((c) =>
        c.cosign(packet).then(
          (r) => r.signature,
          (err) => void reasons.push(...(err instanceof CosignRefused ? err.reasons.slice(0, 2) : [(err as Error).message.slice(0, 160)])),
        ),
      ),
    );
    const quorum = await collectQuorum(digest, [await signDigest(this.svc.account, digest), ...votes], info.verifiers);
    if (quorum.signatures.length < info.threshold) {
      job.refused.set(provider, failures.length);
      await this.receipts.submit({ t: "slash-refused", job: job.reg.jobId, provider, signers: quorum.signers, need: info.threshold, reasons: reasons.slice(0, 3).map((r) => r.slice(0, 160)) });
      this.log(`slash of ${provider} NOT carried: ${quorum.signatures.length} of ${info.threshold} verifiers signed`, { job: job.reg.jobId, reasons: reasons.slice(0, 3) });
      return undefined;
    }

    const { tx, slashId, scheduled } = await this.svc.vault.proposeSlash(verdict, quorum.signatures);
    state.slashed = true;
    const bond = await this.svc.vault.bondOf(provider);
    const expected = owed < bond.amountTinybar ? owed : bond.amountTinybar;
    const receipt = await this.receipts.submit({
      t: "slash",
      job: job.reg.jobId,
      provider,
      buyer: job.reg.buyer,
      refund: expected.toString(),
      vaultTx: tx,
      failures: state.window.failures,
      window: state.window.size,
      slashId,
      signers: quorum.signers,
      ...(state.uaid ? { uaid: state.uaid } : {}),
    });
    const outcome: SlashOutcome = {
      provider,
      buyer: job.reg.buyer,
      jobId: job.reg.jobId,
      refundTinybar: expected,
      vaultTx: tx,
      proposeTx: tx,
      slashId,
      status: "proposed",
      signers: quorum.signers,
      receiptSeq: receipt.sequence,
      ...(scheduled ? { scheduledAt: scheduled.at } : {}),
    };
    job.slashes.push(outcome);
    job.packets.set(slashId, packet);
    // Nothing this provider returned in this job is trusted any more.
    for (const [idx, a] of job.accepted) if (a.provider === provider) job.accepted.delete(idx);
    this.log(`SLASH PROPOSED ${provider}`, { job: job.reg.jobId, refund: expected, signers: quorum.signers.length, tx, ...(scheduled ? { executesItselfAt: new Date(scheduled.at * 1000).toISOString() } : {}) });
    if (info.disputeWindowSeconds === 0) await this.settle(job, outcome);
    return outcome;
  }

  /**
   * Moves one slash forward: executes it once its dispute window has closed, gathers the
   * verifiers' votes when the provider disputed it, and cancels a dispute nobody decided in
   * time. Safe to call repeatedly.
   */
  private async settle(job: JobState, s: SlashOutcome): Promise<void> {
    if (isSettled(s) || !s.slashId) return;
    const id = s.slashId as Hex;
    const [info, rec] = await Promise.all([this.svc.vault.info(), this.svc.vault.slashOf(id)]);
    const now = Date.now() / 1000;
    let result: Settlement | undefined;
    try {
      if (rec.status === "proposed") {
        if (now < rec.proposedAt + info.disputeWindowSeconds) return;
        // The vault executes it itself (HIP-1215): give its scheduled call a moment first.
        if (s.scheduledAt && now < s.scheduledAt + SCHEDULED_GRACE_SECONDS) return;
        result = await this.svc.vault.executeSlash(id);
      } else if (rec.status === "disputed") {
        s.status = "disputed";
        if (!job.reviewed.has(id)) result = await this.decideDispute(job, s, info);
        if (!result && now >= rec.disputedAt + info.resolveTimeoutSeconds) result = await this.svc.vault.executeSlash(id);
      } else if (rec.status !== "none") {
        // Settled by someone else (anyone may call executeSlash, the vault's scheduled call too):
        // take what it paid from the ledger, so the refund and its receipt are still recorded.
        result = await this.svc.vault.settlementOf?.(id, rec.proposedAt).catch(() => undefined);
        if (!result) s.status = rec.status;
      }
    } catch (err) {
      // The relay or the devnet clock can lag the window by a second; the next pass retries.
      if (!/NotYet/.test((err as Error).message)) this.log(`could not settle slash of ${s.provider}`, { error: (err as Error).message });
    }
    if (result) await this.applySettlement(job, s, result);
    this.save(job);
  }

  /** The verifiers re-check a disputed slash; a large enough quorum either way decides it. */
  private async decideDispute(job: JobState, s: SlashOutcome, info: Awaited<ReturnType<Services["vault"]["info"]>>): Promise<Settlement | undefined> {
    const id = s.slashId as Hex;
    const packet = job.packets.get(id);
    if (!packet) return undefined;
    const votes = await Promise.all([this.reviewer, ...this.cosigners].map((r) => r.reviewDispute(packet, id).catch(() => undefined)));
    const counted = votes.filter((v): v is NonNullable<typeof v> => v !== undefined);
    job.reviewed.add(id);
    const upheld = counted.filter((v) => v.upheld).length;
    await this.receipts.submit({ t: "dispute", job: job.reg.jobId, provider: s.provider, slashId: id, upheld, overturned: counted.length - upheld });
    for (const decision of [true, false]) {
      const sigs = counted.filter((v) => v.upheld === decision).map((v) => v.signature);
      const quorum = await collectQuorum(resolutionDigest(id, decision, info), sigs, info.verifiers);
      if (quorum.signatures.length >= info.disputeThreshold) return this.svc.vault.resolveDispute(id, decision, quorum.signatures);
    }
    this.log(`dispute of ${s.provider} undecided (${upheld} uphold, ${counted.length - upheld} overturn); it is cancelled if still undecided at the timeout`);
    return undefined;
  }

  private async applySettlement(job: JobState, s: SlashOutcome, r: Settlement): Promise<void> {
    s.status = r.status;
    s.vaultTx = r.tx;
    s.refundTinybar = r.refundTinybar;
    s.burnedTinybar = r.burnedTinybar;
    await this.receipts.submit({ t: "settle", job: job.reg.jobId, provider: s.provider, slashId: s.slashId!, outcome: r.status, refund: r.refundTinybar.toString(), burned: r.burnedTinybar.toString(), vaultTx: r.tx, ...(r.scheduled ? { scheduled: true } : {}) });
    if (r.status === "executed") this.erc8004Slashed(job, s);
    if (r.status !== "executed") {
      // Overturned or cancelled: the provider keeps its bond and its standing.
      const state = await this.providerState(s.provider);
      state.slashed = false;
      await this.writeReputation(s.provider, state);
    }
    this.log(`slash of ${s.provider} ${r.status.toUpperCase()}`, { job: job.reg.jobId, refund: r.refundTinybar, burned: r.burnedTinybar, tx: r.tx });
  }

  /** Settles every open slash. Runs on a timer while the verifier serves. */
  async settleAll(): Promise<void> {
    for (const job of this.jobs.values()) for (const s of job.slashes) if (!isSettled(s)) await this.lock.run(s.provider, () => this.settle(job, s));
  }

  /** Starts settling open slashes every `ms`, e.g. after their dispute windows close. */
  startSettling(ms = 5000): void {
    this.settleTimer ??= setInterval(() => {
      void this.settleAll().catch((err) => this.log("settle loop failed", { error: (err as Error).message }));
      // Model listings are renewed on Arkiv long before they expire.
      void this.models.renew().catch((err) => this.log("listing renewal failed", { error: (err as Error).message }));
    }, ms);
  }

  stopSettling(): void {
    clearInterval(this.settleTimer);
    this.settleTimer = undefined;
  }

  /** Waits (up to SLASH_SETTLE_WAIT) for a job's slashes to settle, so its passport can show the refunds. */
  private async settleJob(job: JobState): Promise<void> {
    const deadline = Date.now() + this.svc.cfg.quorum.settleWaitSeconds * 1000;
    for (;;) {
      for (const s of job.slashes) if (!isSettled(s)) await this.lock.run(s.provider, () => this.settle(job, s));
      if (job.slashes.every(isSettled) || Date.now() >= deadline) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async finalize(jobId: string, buyer: string) {
    const job = this.jobs.get(jobId);
    if (!job) throw new VerifierError(404, "unknown job");
    if (job.reg.buyer !== buyer.toLowerCase()) throw new VerifierError(403, "not this job's buyer");
    if (!job.finalized) {
      // Refunds land when slashes execute, after their dispute windows: wait for them.
      await this.settleJob(job);
      job.finalized = true;
      await this.receipts.submit({ t: "reveal", job: jobId, canaries: job.plan.indices, salt: job.plan.salt, ...(job.known ? { known: job.known.placements, knownSalt: job.known.salt } : {}) });
      // After the reveal, with every result fixed: PRNG spot checks, then one Merkle anchor.
      await this.spotCheck(job);
      await this.anchorJob(job);
      const paid = [...job.paid.values()].reduce((a, b) => a + b, 0n);
      const refunded = job.slashes.filter((s) => s.status === undefined || s.status === "executed").reduce((a, s) => a + s.refundTinybar, 0n);
      await this.receipts.submit({
        t: "done",
        job: jobId,
        verified: job.accepted.size,
        paid: paid.toString(),
        refunded: refunded.toString(),
        fee: (job.fee?.amountTinybar ?? 0n).toString(),
      });
      this.save(job);
      this.erc8004Feedback(job);
    }
    return {
      jobId,
      commitment: job.plan.commitment,
      canaries: job.plan.indices,
      salt: job.plan.salt,
      accepted: job.accepted.size,
      fee: job.fee,
      paid: Object.fromEntries(job.paid),
      slashes: job.slashes,
      // Scored canaries without labels, for the buyer's Compute Passport.
      checked: job.canaryResults.map((c) => ({ idx: c.idx, provider: c.provider, agreement: Math.round(c.agreement * 1000) / 1000, pass: c.pass, zeroGRequest: c.requestId, model: c.model, ...(c.tee ? { tee: c.tee } : {}) })),
      // Where the known answers were and how each chunk scored. Never the answers themselves.
      ...(job.known ? { known: { commitment: job.known.commitment, placements: job.known.placements, salt: job.known.salt, checked: job.knownResults } } : {}),
      tier: job.tier,
      ...(job.redundancy.length ? { redundancy: job.redundancy } : {}),
      ...(job.anchor ? { anchor: job.anchor } : {}),
      ...(job.spot ? { spot: job.spot } : {}),
    };
  }

  /**
   * Re-runs a few finished chunks on 0G, picked by a Hedera PRNG seed drawn in the vault now,
   * after the reveal (core/spot.ts): no one could know the picks while the work was being done,
   * and the vault allows one draw per job. Best-effort: without a seed there are no spot checks.
   */
  private async spotCheck(job: JobState): Promise<void> {
    const vault = this.svc.vault;
    if (!job.spotChecks || job.spot || !vault.drawSeed) return;
    const jobId = job.reg.jobId;
    const tag = spotTag(jobId);
    try {
      // After a restart mid-finalize the seed may already be drawn: it is the job's only one.
      const draw = (await vault.seedOf?.(tag)) ?? (await vault.drawSeed(tag));
      const picks = spotPicks(draw.seed, jobId, spotCandidates([...job.accepted.keys()], job.plan.indices), job.spotChecks);
      const jobKey = fromBase64(job.reg.jobKey);
      // In parallel (two 0G runs at a time), so finalizing waits for about one run.
      const checked = await Promise.all(picks.map(async (idx): Promise<SpotCheck> => {
        const provider = job.accepted.get(idx)!.provider;
        const output = job.outputs.get(idx);
        try {
          if (!output) throw new Error("no output kept for this chunk");
          const data = job.reg.chunks.find((c) => c.idx === idx)!.data;
          const items = decryptJson<Item[]>(deriveKey(jobKey, `chunk:${idx}`), fromBase64(data));
          const reference = await withTimeout(
            this.withReferenceSlot(() => this.zerogFor(job).reference(job.reg.task, items)),
            SPOT_REFERENCE_TIMEOUT_MS,
          );
          // On the buyer's own items, like a canary: the planted ones were scored against the truth.
          const planted = new Set(job.known?.placements.find((p) => p.idx === idx)?.ids ?? []);
          const score = agreement(job.reg.task, { items: reference.result.items.filter((i) => !planted.has(i.id)) }, { items: output });
          return { idx, provider, agreement: Math.round(score * 1000) / 1000, pass: score >= this.svc.cfg.policy.minAgreement, zeroGRequest: reference.requestId, model: reference.model };
        } catch (err) {
          this.log(`spot check ${jobId}#${idx} not scored`, { error: (err as Error).message });
          return { idx, provider };
        }
      }));
      const receipt = await this.receipts.submit({
        t: "spot",
        job: jobId,
        seed: draw.seed,
        drawnAt: draw.drawnAt,
        ...(draw.tx ? { seedTx: draw.tx } : {}),
        picks,
        checked: checked.map((c) => ({ idx: c.idx, provider: c.provider, ...(c.agreement !== undefined ? { agreement: c.agreement, pass: c.pass, ref: c.zeroGRequest } : {}) })),
      });
      job.spot = { tag, seed: draw.seed, drawnAt: draw.drawnAt, ...(draw.tx ? { seedTx: draw.tx } : {}), picks, checked, hcsSequence: receipt.sequence };
      this.save(job);
      const failed = checked.filter((c) => c.pass === false).map((c) => c.idx);
      this.log(`spot checks for ${jobId}: ${picks.length} picked by PRNG seed ${draw.seed.slice(0, 12)}`, { picks, ...(failed.length ? { disagreed: failed } : {}) });
    } catch (err) {
      this.log(`spot checks for ${jobId} skipped`, { error: (err as Error).message });
    }
  }

  /**
   * Posts one `hcs.merkleRootAnchor` for the job (core/merkle.ts): the root over every finished
   * chunk's record, as the passport lists them. Best-effort, like every receipt after the reveal.
   */
  private async anchorJob(job: JobState): Promise<void> {
    if (job.anchor || job.accepted.size === 0) return;
    const leaves = chunkLeaves(job.reg.jobId, [...job.accepted].map(([idx, a]) => ({ idx, ...a })));
    const anchor = { schema: MERKLE_ANCHOR_SCHEMA, hashAlg: "sha256", leaf: CHUNK_LEAF, merkleRoot: merkleRoot(leaves), recordCount: leaves.length } as const;
    try {
      const receipt = await this.receipts.submit({ t: "anchor", job: job.reg.jobId, schemaVersion: "1", ...anchor, createdAt: new Date().toISOString() });
      job.anchor = { ...anchor, hcsSequence: receipt.sequence, ...(receipt.tx ? { tx: receipt.tx } : {}) };
      this.save(job);
    } catch (err) {
      this.log(`could not anchor ${job.reg.jobId} on HCS`, { error: (err as Error).message });
    }
  }

  /**
   * Co-signs a job's Compute Passport, but only after checking every part the verifier itself
   * recorded: the canary commitment and reveal, the scored canaries, each claimed chunk's
   * provider, result hash and payment, the slashes, the fee and the policy. Anything else
   * in the passport is the buyer's claim, and the verify script checks it against the ledger.
   */
  async attest(jobId: string, buyer: string, body: PassportBody): Promise<Attestation & { digest: string }> {
    const job = this.jobs.get(jobId);
    if (!job) throw new VerifierError(404, "unknown job");
    if (job.reg.buyer !== buyer.toLowerCase()) throw new VerifierError(403, "not this job's buyer");
    if (!job.finalized) throw new VerifierError(409, "finalize the job first");
    const problems: string[] = [];
    const lower = (s: unknown) => String(s ?? "").toLowerCase();

    if (body?.kind !== PASSPORT_KIND || body.jobId !== jobId) problems.push("not this job's passport");
    else if (canonicalJson(body.summary) !== canonicalJson(summarize({ chunks: body.chunks, work: body.work, known: body.canaries?.known, checked: body.canaries?.checked ?? [], providers: body.providers, agreement: body.agreement, revealed: body.canaries?.revealed }))) problems.push("the summary doesn't follow from the evidence");
    if (job.agreementHash && (!body?.agreement || agreementHash(body.agreement) !== job.agreementHash)) problems.push("agreement differs from the one committed");
    if (lower(body?.buyer?.address) !== job.reg.buyer) problems.push("wrong buyer");
    const c = body?.canaries;
    if (!c || c.commitment !== job.plan.commitment || c.salt !== job.plan.salt || JSON.stringify(c.revealed) !== JSON.stringify(job.plan.indices)) {
      problems.push("canary commitment or reveal differs");
    }
    const key = (idx: number, provider: string, pass: boolean, ref: string) => `${idx}|${lower(provider)}|${pass}|${ref}`;
    const mine = job.canaryResults.map((r) => key(r.idx, r.provider, r.pass, r.requestId)).sort();
    const theirs = (c?.checked ?? []).map((r) => key(r.idx, r.provider, r.pass, r.zeroGRequest)).sort();
    if (JSON.stringify(mine) !== JSON.stringify(theirs)) problems.push("scored canaries differ");
    // Each canary's TEE evidence (provider, chat id, signature, signer, our result) is what this verifier recorded.
    const teeOf = (idx: number, provider: string, t: unknown) => `${idx}|${lower(provider)}|${t === undefined ? "" : canonicalJson(t)}`;
    const myTee = job.canaryResults.map((r) => teeOf(r.idx, r.provider, r.tee)).sort();
    const theirTee = (c?.checked ?? []).map((r) => teeOf(r.idx, r.provider, r.tee)).sort();
    if (JSON.stringify(myTee) !== JSON.stringify(theirTee)) problems.push("canary TEE evidence differs");
    // High assurance: every chunk's agreeing copies are the ones recorded here.
    const agreed = new Map(job.redundancy.map((r) => [r.idx, r]));
    for (const w of body?.work ?? []) {
      const r = agreed.get(w.idx);
      if (TIER_RULES[job.tier].copies > 1 && (!r || !w.redundancy || lower(w.redundancy.with) !== r.providers[1] || w.redundancy.agreement !== r.agreement)) {
        problems.push(`chunk ${w.idx}'s independent copies are not what the verifier recorded`);
        break;
      }
    }
    // Known answers: the same commitment, placements and scores as recorded here.
    const k = body?.canaries?.known;
    if (job.known) {
      const scores = (rs: KnownResult[]) => rs.map((r) => `${r.idx}|${lower(r.provider)}|${r.correct}|${r.pass}`).sort();
      if (!k || k.commitment !== job.known.commitment || k.salt !== job.known.salt || canonicalJson(k.placements) !== canonicalJson(job.known.placements)) problems.push("known-answer placements differ");
      else if (JSON.stringify(scores(k.checked)) !== JSON.stringify(scores(job.knownResults))) problems.push("known-answer checks differ");
    } else if (k) problems.push("no known answers were planted in this job");

    // Every chunk the passport claims must be one the verifier accepted, with the same result and payment.
    const passed = new Set(job.canaryResults.filter((r) => r.pass).map((r) => `${r.idx}|${r.provider}`));
    for (const w of body?.work ?? []) {
      const a = job.accepted.get(w.idx);
      if (!a || a.provider !== lower(w.provider) || a.resultHash !== w.resultHash || a.payTx !== w.payTx) {
        problems.push(`chunk ${w.idx} is not what the verifier accepted`);
        break;
      }
      if ((w.attestation ?? undefined) !== a.attestation) {
        problems.push(`chunk ${w.idx}'s attestation is not what the verifier found`);
        break;
      }
      if (w.check === "verified" && !passed.has(`${w.idx}|${a.provider}`)) {
        problems.push(`chunk ${w.idx} is marked verified without a passing canary`);
        break;
      }
    }
    if ((body?.work ?? []).length !== body?.completed) problems.push("completed count differs from the chunks listed");

    for (const s of job.slashes) {
      const p = (body?.providers ?? []).find((x) => lower(x.address) === s.provider);
      if (!p || p.status !== "slashed" || p.vaultTx !== s.vaultTx || p.refund !== s.refundTinybar.toString() || (s.slashId && (p.slashId !== s.slashId || p.slashStatus !== s.status))) {
        problems.push(`slash of ${s.provider} differs`);
      }
    }
    if (job.fee && body?.verificationFee?.tx !== job.fee.tx) problems.push("verification fee differs");
    // The model and its royalty: the listing's terms, and the payment recorded here.
    const m = body?.model;
    if (job.model) {
      if (!m || m.key !== job.model.key || m.passportDigest !== job.model.passport || m.royaltyBps !== job.model.royaltyBps || m.payTo !== job.model.payTo) problems.push("the model differs from the job's");
      else if (job.royalty ? !m.royalty || m.royalty.tx !== job.royalty.tx || m.royalty.amount !== job.royalty.amount.toString() || m.royalty.basis !== job.royalty.basis.toString() : !!m.royalty) problems.push("the royalty differs from the one recorded");
      // A job whose creator is owed a royalty gets no co-signed passport until it is paid.
      else if (!job.royalty && royaltyOf([...job.accepted.values()].reduce((x, y) => x + BigInt(y.amount ?? 0), 0n), job.model.royaltyBps) > 0n) problems.push("the creator's royalty hasn't been paid");
    } else if (m) problems.push("this job ran no listed model");
    // The HCS Merkle anchor and the PRNG spot checks: exactly what this verifier posted.
    const anchorOf = (a?: Partial<JobAnchor>) => (a ? canonicalJson({ merkleRoot: a.merkleRoot, recordCount: a.recordCount, hcsSequence: a.hcsSequence, leaf: a.leaf }) : "");
    if (anchorOf(job.anchor) !== anchorOf(body?.anchor)) problems.push("the Merkle anchor differs from the one posted on HCS");
    const spotOf = (x?: Partial<JobSpot>) => (x ? canonicalJson({ seed: x.seed, drawnAt: x.drawnAt, picks: x.picks, checked: x.checked, hcsSequence: x.hcsSequence }) : "");
    if (spotOf(job.spot) !== spotOf(body?.spot)) problems.push("the spot checks differ from the ones recorded");
    const { canaryRate, minAgreement, window, failLimit } = this.svc.cfg.policy;
    if (JSON.stringify(body?.policy) !== JSON.stringify({ canaryRate, minAgreement, window, failLimit })) problems.push("policy differs");

    if (problems.length > 0) throw new VerifierError(409, `won't co-sign: ${problems.join("; ")}`);
    const signed = await signPassport(this.svc.account, body);
    job.attested = passportDigest(body);
    this.save(job);
    this.log(`co-signed the Compute Passport for ${jobId}`);
    return { ...signed, uaid: await this.identity(), digest: job.attested };
  }

  /**
   * Stores the buyer's signed Compute Passport on 0G Storage, paying the storage fee from this
   * verifier's 0G wallet, and returns its root. Only the job's buyer may store it, signed by that
   * buyer; if this verifier co-signed the job's passport, it must be that same passport carrying
   * this verifier's own signature. Storing again returns the same root; a different one is refused.
   */
  async storePassport(jobId: string, buyer: string, passport: Passport): Promise<{ ref: string; url: string; digest: string }> {
    const job = this.jobs.get(jobId);
    if (!job) throw new VerifierError(404, "unknown job");
    if (job.reg.buyer !== buyer.toLowerCase()) throw new VerifierError(403, "not this job's buyer");
    if (!job.finalized) throw new VerifierError(409, "finalize the job first");
    if (passport?.kind !== PASSPORT_KIND || passport.jobId !== jobId) throw new VerifierError(400, "not this job's passport");
    const body = passportBody(passport);
    const digest = passportDigest(body);
    if (job.passport) {
      if (job.passport.digest !== digest) throw new VerifierError(409, "a different passport is already stored for this job");
      return { ...job.passport, url: this.svc.storage.url(job.passport.ref) };
    }
    const b = passport.attestations?.buyer;
    if (!b || (await signerOf(body, b.signature)) !== job.reg.buyer) throw new VerifierError(400, "the passport isn't signed by this job's buyer");
    if (job.attested) {
      if (digest !== job.attested) throw new VerifierError(409, "this isn't the passport this verifier co-signed");
      const v = passport.attestations?.verifier;
      if (!v || (await signerOf(body, v.signature)) !== this.svc.address) throw new VerifierError(400, "the passport doesn't carry this verifier's signature");
    }
    const ref = await this.svc.storage.upload(new TextEncoder().encode(JSON.stringify(passport, null, 2)));
    job.passport = { ref, digest };
    this.save(job);
    this.log(`stored the Compute Passport for ${jobId} on 0G Storage`, { ref });
    return { ref, url: this.svc.storage.url(ref), digest };
  }

  /**
   * What the buyer owes the model's creator: the royalty share of the payments for the chunks the
   * verifier accepted as final. Refunded, rerouted and failed chunks are never in it, and it can be
   * paid once, after the job is finalized.
   */
  royaltyDue(jobId: string, buyer: string): { model: string; payTo: string; royaltyBps: number; basis: bigint; amount: bigint; chunks: number } {
    const job = this.jobs.get(jobId);
    if (!job) throw new VerifierError(404, "unknown job");
    if (job.reg.buyer !== buyer.toLowerCase()) throw new VerifierError(403, "not this job's buyer");
    if (!job.model) throw new VerifierError(400, "this job runs no listed model");
    if (!job.finalized) throw new VerifierError(409, "finalize the job first");
    if (job.royalty) throw new VerifierError(409, "the royalty was already paid");
    const basis = [...job.accepted.values()].reduce((a, x) => a + BigInt(x.amount ?? 0), 0n);
    return { model: job.model.key, payTo: job.model.payTo, royaltyBps: job.model.royaltyBps, basis, amount: royaltyOf(basis, job.model.royaltyBps), chunks: job.accepted.size };
  }

  /** Records the royalty payment (settled over x402 to the creator) and logs it on HCS. */
  async recordRoyalty(jobId: string, due: { basis: bigint; amount: bigint; chunks: number }, tx: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job?.model) return;
    job.royalty = { amount: due.amount, basis: due.basis, chunks: due.chunks, tx };
    this.save(job);
    await this.receipts.submit({ t: "royalty", job: jobId, model: job.model.key, payTo: job.model.payTo, amount: due.amount.toString(), basis: due.basis.toString(), chunks: due.chunks, tx });
    this.log(`royalty for ${jobId} paid to the creator of ${job.model.id}`, { amount: due.amount, tx });
  }

  /** Records the x402 verification fee a buyer paid to register a job. */
  recordFee(jobId: string, amountTinybar: bigint, tx: string): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.fee = { amountTinybar, tx };
      this.save(job);
    }
    this.earnedTinybar += amountTinybar;
    this.feePayments += 1;
  }

  /** Scored canaries of a job, newest last. */
  canaries(jobId: string): CanaryResult[] {
    const job = this.jobs.get(jobId);
    if (!job) throw new VerifierError(404, "unknown job");
    return job.canaryResults;
  }

  /**
   * Admission check before a provider gets paid work. The verifier pays the provider for one
   * probe chunk of known-answer tickets that looks exactly like real work, then checks format
   * and accuracy against the true labels (ground truth, not another model). Results are cached
   * per provider and logged on HCS.
   */
  async qualify(req: QualifyRequest, signer?: string): Promise<Qualification> {
    const provider = req.provider.toLowerCase();
    const state = await this.providerState(provider);
    const job = req.jobId ? this.jobs.get(req.jobId) : undefined;
    if (req.jobId && !job) throw new VerifierError(404, "unknown job");
    if (job && signer && job.reg.buyer !== signer.toLowerCase()) throw new VerifierError(403, "not this job's buyer");

    // The buyer's own examples: a probe for this job only, judged at the agreed accuracy.
    if (job?.gold) {
      const gold = { task: job.reg.task, items: job.gold };
      return this.qualifyOnce(
        `${provider}|${job.reg.jobId}`,
        () => job.qualifications.get(provider),
        () =>
          this.probe(provider, state, req, gold, job.agreement!.admission.minAccuracy, job.reg.jobId).then((q) => {
            job.qualifications.set(provider, q);
            this.save(job);
            return q;
          }),
      );
    }

    // The verifier's own examples for this task: one probe serves every job of the task for a
    // while; each job applies its own bar. Passing one task's probe admits nothing else.
    const gold = goldFor(this.admission, req.task);
    // Admission is per task, and per model for a model job: the probes run on that model.
    const taskKey = `${gold ? taskHash(gold.task) : "none"}${req.model ? `|${req.model}` : ""}`;
    const q = await this.qualifyOnce(
      `${provider}|${taskKey}`,
      () => {
        const c = state.qualifications.get(taskKey);
        return c && Date.now() - c.checkedAt < (c.admitted ? QUAL_TTL_MS : QUAL_RETRY_MS) ? c : undefined;
      },
      () =>
        this.probe(provider, state, req, gold ?? null, this.svc.cfg.policy.minAgreement).then((r) => {
          state.qualifications.set(taskKey, r);
          return r;
        }),
    );
    const bar = job?.agreement?.admission.minAccuracy ?? this.svc.cfg.policy.minAgreement;
    if (q.skipped || !q.admitted || q.agreement >= bar) return q;
    return { ...q, admitted: false, reason: `matched ${Math.round(q.agreement * 100)}% of known answers; this job needs ${Math.round(bar * 100)}%` };
  }

  private qualifyOnce(key: string, cached: () => Qualification | undefined, run: () => Promise<Qualification>): Promise<Qualification> {
    const hit = cached();
    if (hit) return Promise.resolve(hit);
    const inflight = this.qualifying.get(key);
    if (inflight) return inflight;
    const p = run().finally(() => this.qualifying.delete(key));
    this.qualifying.set(key, p);
    return p;
  }

  /**
   * One paid probe. `jobId` is set for a job's own examples: the result then belongs to that
   * job only and stays off the provider's public reputation.
   */
  private async probe(
    provider: string,
    state: ProviderState,
    req: QualifyRequest,
    gold: GoldSet | null,
    minAccuracy: number,
    jobId?: string,
  ): Promise<Qualification> {
    if (!goldFits(gold, req.task)) {
      const skipped: Qualification = { provider, admitted: true, agreement: 1, formatOk: true, latencyMs: 0, checkedAt: Date.now(), skipped: true, reason: "no known-answer set for this task" };
      if (!jobId) state.qualification = skipped;
      return skipped;
    }

    // A probe that looks like any other chunk: a normal job id, normal-looking item ids.
    const sample = [...gold.items].sort(() => Math.random() - 0.5).slice(0, QUAL_ITEMS);
    const ids = new Set<string>();
    while (ids.size < sample.length) ids.add(`t${String(randomInt(1, 1000)).padStart(3, "0")}`);
    const idList = [...ids];
    const items = sample.map((g, i) => ({ id: idList[i], text: g.text }));
    const truth = { items: sample.map((g, i) => truthOf(req.task, g, idList[i])) };
    const started = Date.now();
    let result: Qualification;
    try {
      const { body, payTx, latencyMs } = await this.paidChunk(provider, req, items);
      const problems = validateResult(req.task, items, body.result);
      const score = agreement(req.task, truth, body.result);
      const admitted = problems.length === 0 && score >= minAccuracy;
      result = {
        provider,
        admitted,
        agreement: score,
        formatOk: problems.length === 0,
        latencyMs,
        payTx,
        checkedAt: Date.now(),
        reason: admitted ? undefined : problems.length ? `malformed: ${problems[0]}` : `matched ${Math.round(score * 100)}% of known answers`,
      };
    } catch (err) {
      result = { provider, admitted: false, agreement: 0, formatOk: false, latencyMs: Date.now() - started, checkedAt: Date.now(), reason: (err as Error).message };
    }
    // Admitted on the verifier's own examples: also check it runs the model it declares
    // (the fingerprints were measured on the ticket task).
    if (result.admitted && !jobId && this.fingerprintTask && goldFits(gold, this.fingerprintTask)) result.fingerprint = await this.fingerprint(provider, state, req);
    if (!jobId) {
      state.qualification = result;
      this.recordCheck(provider, "", -1, "admission", result.admitted);
    }
    await this.receipts.submit({
      t: "qualify",
      provider,
      ...(jobId ? { job: jobId } : {}),
      ...(state.uaid ? { uaid: state.uaid } : {}),
      admitted: result.admitted,
      agreement: Math.round(result.agreement * 1000) / 1000,
      latencyMs: result.latencyMs,
      payTx: result.payTx ?? "",
      reason: result.reason,
    });
    if (!jobId) await this.writeReputation(provider, state);
    this.log(`qualification ${result.admitted ? "ADMITTED" : "REJECTED"} ${provider}`, { agreement: result.agreement.toFixed(2), latencyMs: result.latencyMs, reason: result.reason });
    return result;
  }

  /**
   * One paid chunk to a provider that looks like any other: its own random job id, chunk index
   * and item ids, never the real job's. Throws if the provider fails or the result isn't its own.
   */
  private async paidChunk(provider: string, req: QualifyRequest, items: Item[]): Promise<{ body: ChunkResponse; payTx: string; latencyMs: number }> {
    const key = randomKey();
    const probeJobId = `job-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const probeIdx = randomInt(0, 40);
    // Wrapped like a buyer's, so a probe looks like any other chunk.
    const encKey = (await this.providerState(provider)).encKey;
    const started = Date.now();
    const data = toBase64(encryptJson(key, items));
    const paid = await payFetch(
      `${req.endpoint}/v1/chunks`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: probeJobId, idx: probeIdx, task: req.task, data, ...(encKey ? { wrappedKey: wrapKey(encKey, key, wrapContext(probeJobId, probeIdx, provider)) } : { chunkKey: toBase64(key) }), ...(req.model ? { model: req.model } : {}) }),
        signal: AbortSignal.timeout(180_000),
      },
      this.svc.payer(),
      QUAL_MAX_PRICE,
    );
    const latencyMs = Date.now() - started;
    if (!paid.response.ok || !paid.settlement?.success) {
      // A 402 here means the payment itself was refused (by the gate or the facilitator): say why.
      const body = (await paid.response.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new Error(`provider answered ${paid.response.status}${body.error || body.message ? `: ${String(body.error ?? body.message).slice(0, 160)}` : ""}`);
    }
    const body = (await paid.response.json()) as ChunkResponse;
    const signer = await recoverResultSigner(body.jobId, body.idx, body.resultHash, body.signature as `0x${string}`, executionHash(body.execution), body.model);
    if (signer !== provider) throw new Error("probe result not signed by the provider");
    if (req.model && body.model !== req.model) throw new Error("probe result not signed for the model asked for");
    return { body, payTx: paid.settlement.transaction, latencyMs };
  }

  /**
   * Model check: a paid chunk of borderline tickets that tell the declared model apart from
   * others (data/fingerprints.json). Evidence only: it is recorded and shown, never slashes.
   */
  private async fingerprint(provider: string, state: ProviderState, req: QualifyRequest): Promise<Qualification["fingerprint"]> {
    // A model job checks against that model's own fingerprint, from its Model Passport.
    const fromModel = req.model ? this.modelFingerprint(req.model) : undefined;
    const declared = req.model ?? modelOf(state.backend);
    const set = fromModel?.set ?? this.fingerprints;
    const probes = fromModel?.probes ?? (declared ? this.fingerprints?.probes[declared] : undefined);
    const labels = (t: TaskSpec) => JSON.stringify((t.labels ?? []).map((l) => l.name).sort());
    if (!declared || !set || !probes || probes.length < 3 || !this.fingerprintTask || labels(req.task) !== labels(this.fingerprintTask)) return undefined;
    // Every probe item (12 measure far better than 6), sent as normal-sized chunks of six.
    const sample = [...probes].sort(() => Math.random() - 0.5);
    const ids = new Set<string>();
    while (ids.size < sample.length) ids.add(`t${String(randomInt(1, 1000)).padStart(3, "0")}`);
    const idList = [...ids];
    let fp: NonNullable<Qualification["fingerprint"]>;
    try {
      const answers: Record<string, string> = {};
      let payTx = "";
      for (let start = 0; start < sample.length; start += QUAL_ITEMS) {
        const part = sample.slice(start, start + QUAL_ITEMS);
        const { body, payTx: tx } = await this.paidChunk(provider, req, part.map((p, i) => ({ id: idList[start + i], text: p.text })));
        payTx ||= tx;
        // Back to the fingerprint ids, so the answers compare with every known model's.
        part.forEach((p, i) => {
          const label = body.result.items.find((it) => it.id === idList[start + i])?.label;
          if (label) answers[p.id] = label;
        });
      }
      fp = { ...judgeFingerprint(answers, set, declared), payTx };
    } catch (err) {
      fp = { declared, match: 0, verdict: "inconclusive", items: 0, reason: (err as Error).message };
    }
    await this.receipts.submit({
      t: "fingerprint",
      provider,
      ...(state.uaid ? { uaid: state.uaid } : {}),
      declared,
      verdict: fp.verdict,
      match: fp.match,
      ...(fp.closest ? { closest: fp.closest } : {}),
      payTx: fp.payTx ?? "",
    });
    this.log(`model check ${fp.verdict.toUpperCase()} ${provider}`, { declared, match: fp.match, closest: fp.closest, reason: fp.reason });
    return fp;
  }

  /**
   * A listed model's fingerprint set: its passport's answers on the probe items, next to every
   * other measured model's, and the items that tell it apart (or all of them when none do).
   */
  private modelFingerprint(key: string): { set: Pick<FingerprintSet, "models">; probes: FingerprintItem[] } | undefined {
    const answers = this.models.get(key)?.fingerprint?.answers;
    if (!answers) return undefined;
    const known = Object.fromEntries(Object.entries(this.fingerprints?.models ?? {}).map(([m, a]) => [m, [a]]));
    const built = buildProbes({ ...known, [key]: [answers] }, this.probeTexts);
    const all = Object.entries(answers)
      .filter(([id]) => this.probeTexts[id])
      .slice(0, 12)
      .map(([id, label]) => ({ id, text: this.probeTexts[id], label }));
    return { set: { models: built.models }, probes: built.probes[key]?.length >= 3 ? built.probes[key] : all };
  }

  /** Chunks the verifier accepts as final, with the provider that produced each. */
  accepted(jobId: string): Map<number, string> {
    return new Map([...(this.jobs.get(jobId)?.accepted ?? [])].map(([idx, a]) => [idx, a.provider]));
  }

  private uaid?: Promise<string>;

  /** The verifier's own HCS-14 UAID. */
  identity(): Promise<string> {
    this.uaid ??= uaidFor(agentProfile({ role: "verifier", name: "kinetic-verifier", network: this.svc.cfg.network, hederaAccountId: this.svc.identity.hederaAccountId, evmAddress: this.svc.address }), this.svc.address);
    return this.uaid;
  }

  // ── ERC-8004 on 0G Chain ──

  private erc8004?: Erc8004;
  private erc8004Agent?: Registration;
  private erc8004Queue: Promise<unknown> = Promise.resolve();

  /** Registers this verifier as an ERC-8004 agent (once) and turns on reputation feedback. */
  startErc8004(): void {
    const cfg = this.svc.cfg.erc8004;
    if (!cfg.enabled || this.erc8004) return;
    this.erc8004 = new Erc8004(cfg, this.svc.account);
    this.erc8004Write(async () => {
      const reg = await ensureAgent(
        this.erc8004!,
        this.svc.address,
        () => ({
          name: "KINETIC verifier",
          description: "Checks every KINETIC job: hidden known answers and 0G TeeML canaries, a quorum to slash a GPU's bond on Hedera and refund the buyer, and a Model Passport for every listed model. Its feedback here is each GPU's measured share of passed checks.",
          services: [{ name: "web", endpoint: `${this.svc.cfg.network}:${this.svc.address}` }, ...(this.svc.cfg.hedera.vaultAddress ? [{ name: "bond-vault", endpoint: `hedera:testnet:${this.svc.cfg.hedera.vaultAddress}` }] : []), { name: "hcs-receipts", endpoint: `hedera:testnet:${this.receipts.topicId}` }],
          x402Support: true,
          active: true,
          supportedTrust: ["reputation", "crypto-economic", "tee-attestation"],
        }),
        this.svc.cfg.stateDir,
      );
      this.erc8004Agent = reg;
      this.log("ERC-8004 agent on 0G", { agentId: reg.agentId, tx: reg.tx });
    }, "registration");
  }

  /** One 0G transaction at a time: they share this verifier's nonce. Failures are logged, never fatal. */
  private erc8004Write(fn: () => Promise<unknown>, what: string): void {
    this.erc8004Queue = this.erc8004Queue.then(fn).catch((err: Error) => this.log(`ERC-8004 ${what} failed`, { error: err.message.slice(0, 200) }));
  }

  /** After a job: each GPU's share of the job's hidden checks it passed, as ERC-8004 feedback. */
  private erc8004Feedback(job: JobState): void {
    if (!this.erc8004) return;
    const by = new Map<string, { checks: number; passed: number }>();
    for (const r of [...job.knownResults, ...job.canaryResults]) {
      const t = by.get(r.provider) ?? { checks: 0, passed: 0 };
      t.checks++;
      if (r.pass) t.passed++;
      by.set(r.provider, t);
    }
    for (const [provider, t] of by) {
      this.erc8004Write(async () => {
        const state = await this.providerState(provider);
        if (state.erc8004 === undefined || t.checks === 0) return;
        // Only to an identity the GPU itself owns: an offer can't borrow another agent's id.
        if ((await this.erc8004!.ownerOf(state.erc8004)) !== provider) return;
        const successRate = Math.round((100 * t.passed) / t.checks);
        const tx = await this.erc8004!.giveFeedback({
          agentId: state.erc8004,
          value: successRate,
          tag1: "successRate",
          tag2: "kinetic",
          evidence: { kind: "kinetic.erc8004-feedback.v1", job: job.reg.jobId, provider, checks: t.checks, passed: t.passed, hcsTopic: this.receipts.topicId, verifier: this.svc.address },
        });
        this.log(`ERC-8004 feedback for ${state.name ?? provider}`, { agentId: state.erc8004, successRate, tx });
      }, "feedback");
    }
  }

  /** A slash that executed is public on the GPU's ERC-8004 record too. */
  private erc8004Slashed(job: JobState, s: SlashOutcome): void {
    if (!this.erc8004) return;
    this.erc8004Write(async () => {
      const state = await this.providerState(s.provider);
      if (state.erc8004 === undefined || (await this.erc8004!.ownerOf(state.erc8004)) !== s.provider) return;
      const tx = await this.erc8004!.giveFeedback({
        agentId: state.erc8004,
        value: 1,
        tag1: "slashed",
        tag2: "kinetic",
        evidence: { kind: "kinetic.erc8004-slash.v1", job: job.reg.jobId, provider: s.provider, refundTinybar: s.refundTinybar.toString(), vaultTx: s.vaultTx, hcsTopic: this.receipts.topicId },
      });
      this.log(`ERC-8004 slash recorded for ${state.name ?? s.provider}`, { agentId: state.erc8004, tx });
    }, "slash feedback");
  }

  /** On-chain reputation this verifier gave, per agent id: average success rate and slashes. */
  async erc8004Reputation(agentIds: number[]): Promise<{ agentId: number; owner: string | null; jobs: number; successRate: number | null; slashes: number }[]> {
    if (!this.erc8004) return [];
    return Promise.all(
      agentIds.map(async (agentId) => {
        const [owner, rate, slashes] = await Promise.all([
          this.erc8004!.ownerOf(agentId),
          this.erc8004!.summary(agentId, [this.svc.address], "successRate", "kinetic").catch(() => ({ count: 0, value: 0 })),
          this.erc8004!.summary(agentId, [this.svc.address], "slashed", "kinetic").catch(() => ({ count: 0, value: 0 })),
        ]);
        return { agentId, owner, jobs: rate.count, successRate: rate.count ? rate.value : null, slashes: slashes.count };
      }),
    );
  }

  async status() {
    return {
      uaid: await this.identity(),
      network: this.svc.cfg.network,
      verifier: this.svc.address,
      hcsTopic: this.receipts.topicId,
      ...(this.erc8004
        ? { erc8004: { chainId: this.svc.cfg.erc8004.chainId, identityRegistry: this.svc.cfg.erc8004.identityRegistry, reputationRegistry: this.svc.cfg.erc8004.reputationRegistry, explorerUrl: this.svc.cfg.erc8004.explorerUrl, ...(this.erc8004Agent ? { agentId: this.erc8004Agent.agentId, tx: this.erc8004Agent.tx } : {}) } }
        : {}),
      vault: this.svc.cfg.network === "testnet" ? this.svc.cfg.hedera.vaultAddress : undefined,
      payment: { asset: this.svc.cfg.x402.asset, symbol: this.svc.cfg.x402.symbol, decimals: this.svc.cfg.x402.decimals },
      mirrorUrl: this.svc.cfg.hedera.mirrorUrl,
      storageGateway: this.svc.storage.gateway,
      arkiv: { app: this.svc.arkiv.app, rpcUrl: this.svc.cfg.arkiv.rpcUrl, chainId: this.svc.cfg.arkiv.chainId, explorerUrl: this.svc.cfg.arkiv.explorerUrl, devnetUrl: this.svc.cfg.network === "devnet" ? this.svc.cfg.devnetUrl : undefined },
      policy: this.svc.cfg.policy,
      quorum: await this.svc.vault.info().then(
        (i) => ({ verifiers: i.verifiers, threshold: i.threshold, disputeThreshold: i.disputeThreshold, disputeWindowSeconds: i.disputeWindowSeconds, resolveTimeoutSeconds: i.resolveTimeoutSeconds, cosigners: this.cosigners.length }),
        () => undefined,
      ),
      zerog: { ...this.zerog.stats(), balance: await this.zerog.balance() },
      // The verifier spends 0G credits on reference runs and earns HBAR fees for verification.
      earnings: { feesTinybar: this.earnedTinybar, feePayments: this.feePayments, feePerChunkTinybar: this.svc.cfg.verifierFeePerChunkTinybar },
      jobs: this.jobs.size,
      models: this.models.list().map((m) => ({ key: m.key, id: m.card.id, version: m.card.version, accuracy: m.accuracy, passportRef: m.passportRef, signers: m.signers.length })),
      providers: Object.fromEntries(
        [...this.providers].map(([p, s]) => [
          p,
          { pass: s.pass, fail: s.fail, slashed: s.slashed, windowFailures: s.window.failures, windowSize: s.window.size, latencyMs: median(s.latencies), qualification: s.qualification },
        ]),
      ),
    };
  }

  // Provider state is rebuilt from Arkiv (offer for payTo, reputation for history) on first sight.
  private async providerState(provider: string): Promise<ProviderState> {
    let state = this.providers.get(provider);
    let legacyRep: string | undefined;
    if (!state) {
      state = { window: new CanaryWindow(this.svc.cfg.policy), pass: 0, fail: 0, slashed: false, latencies: [], qualifications: new Map() };
      // Created and still owned by this verifier (the creator never changes); the newest if several.
      const [rep] = await this.svc.arkiv.query("reputation", { provider }, { owner: this.svc.address, creator: this.svc.address, limit: 1, orderBy: { attr: "$expiresAt", desc: true } });
      if (rep) {
        // One written before named schemas is re-created on its schema below, then deleted.
        if (rep.legacy) legacyRep = rep.key;
        else state.reputationKey = rep.key;
        state.pass = Number(attrBig(rep, "pass"));
        state.fail = Number(attrBig(rep, "fail"));
        state.slashed = attrStr(rep, "status") === "slashed";
        // Recent outcomes too, so a restart can't hand a provider near its limit a clean window.
        state.window = CanaryWindow.restore(this.svc.cfg.policy, attrStr(rep, "window"));
      }
      if ((await this.svc.vault.bondOf(provider)).slashed) state.slashed = true;
      this.providers.set(provider, state);
    }
    if (!state.payTo) {
      // Only an offer the provider created itself and still owns; the newest if it has two.
      const [offer] = await this.svc.arkiv.query("offer", { provider }, { owner: provider, creator: provider, limit: 1, orderBy: { attr: "$expiresAt", desc: true } });
      if (offer) {
        state.payTo = attrStr(offer, "pay_to");
        state.name = attrStr(offer, "name");
        state.uaid = attrStr(offer, "uaid") || undefined;
        state.gpu = attrStr(offer, "gpu");
        state.adversarial = attrStr(offer, "adversarial") || undefined;
        state.backend = (offer.payload as { backend?: string } | null)?.backend;
        state.zgProvider = attrStr(offer, "zg_provider").toLowerCase() || undefined;
        state.encKey = (offer.payload as { encKey?: string } | null)?.encKey;
        if (offer.attrs.erc8004 !== undefined) state.erc8004 = Number(offer.attrs.erc8004);
      }
    }
    if (legacyRep) {
      await this.writeReputation(provider, state);
      if (state.reputationKey) this.svc.arkiv.remove(legacyRep).catch((err) => this.log("old reputation delete failed", { provider, error: (err as Error).message }));
    }
    return state;
  }

  /**
   * The 0G execution record on a result, checked independently of the provider:
   * - it names the 0G Compute provider the offer declares, and a chat id never used before;
   * - the response bytes hash to the record's responseHash, and the result is what they say;
   * - the 0G provider's TEE signed that same responseHash, recovering to the signer on the 0G chain.
   * Anything that contradicts the record is "invalid" and rejected. Nothing to check is
   * "unavailable": accepted, and labelled as such, never as verified.
   */
  private async checkExecution(job: JobState, state: ProviderState, response: ChunkResponse): Promise<{ execution?: ExecutionCheck; problem?: string }> {
    const itemIds = job.reg.chunks.find((c) => c.idx === response.idx)?.itemIds;
    const { execution, problem, chatKey } = await checkExecutionRecord(this.svc.cfg, job.reg.task, itemIds, state.zgProvider, response, (key) => this.seenChats.has(key));
    // A 0G run backs one result only: recorded on disk before the result it backs is accepted.
    if (!problem && chatKey) this.useChat(chatKey);
    return { execution, problem };
  }

  /**
   * One check as its own Arkiv entity, owned by the verifier, that expires after TTL.check. A
   * provider's live record is a count of these, so old results age out on their own and no
   * operator has to keep a flag current. Created readonly: nobody, this verifier included, can
   * change a check once written. Written in the background: it never holds up a verdict.
   */
  private recordCheck(provider: string, jobId: string, idx: number, src: "known" | "canary" | "format" | "execution" | "admission" | "redundant", pass: boolean): void {
    this.svc.arkiv
      .create({ kind: "check", attrs: { provider, src, pass: pass ? 1 : 0, at: Math.floor(Date.now() / 1000), ...(jobId ? { job_id: jobId, idx } : {}) }, ttlSeconds: TTL.check, readonly: true })
      .catch((err) => this.log("check write failed", { provider, error: (err as Error).message }));
  }

  private async writeReputation(provider: string, state: ProviderState) {
    const total = state.pass + state.fail;
    const q = state.qualification;
    const attrs = {
      provider,
      pass: state.pass,
      fail: state.fail,
      score: total === 0 ? 100 : Math.round((state.pass / total) * 100),
      status: state.slashed ? "slashed" : "ok",
      // The slash window, oldest first ("1" pass, "0" fail); within Arkiv's 128-byte cap.
      ...(state.window.size > 0 ? { window: state.window.toString().slice(-128) } : {}),
      latency_ms: median(state.latencies) ?? q?.latencyMs ?? 0,
      // Kept here so a provider stays named after its offer expires.
      ...(state.name ? { name: state.name.slice(0, 64), gpu: (state.gpu ?? "").slice(0, 64) } : {}),
      ...(state.adversarial ? { adversarial: state.adversarial.slice(0, 120) } : {}),
      // Reputation is keyed by address and labelled with the HCS-14 identity it belongs to.
      ...(state.uaid ? { uaid: state.uaid } : {}),
      ...(q && !q.skipped ? { qual_status: q.admitted ? "admitted" : "rejected", qual_agreement: Math.round(q.agreement * 100) } : {}),
      // The model check: whether it answers like the model it declares.
      ...(q?.fingerprint ? { fp_status: q.fingerprint.verdict, fp_match: Math.round(q.fingerprint.match * 100), fp_model: q.fingerprint.declared.slice(0, 64), ...(q.fingerprint.closest ? { fp_closest: q.fingerprint.closest.slice(0, 64) } : {}) } : {}),
    };
    try {
      if (state.reputationKey) {
        await this.svc.arkiv.patch(state.reputationKey, attrs);
        await this.svc.arkiv.extend(state.reputationKey, TTL.reputation);
      } else {
        state.reputationKey = await this.svc.arkiv.create({ kind: "reputation", attrs, ttlSeconds: TTL.reputation });
      }
    } catch (err) {
      this.log("reputation write failed", { provider, error: (err as Error).message });
    }
  }

  private async withReferenceSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.referenceSlots === 0) await new Promise<void>((r) => this.referenceWaiters.push(r));
    this.referenceSlots -= 1;
    try {
      return await fn();
    } finally {
      this.referenceSlots += 1;
      this.referenceWaiters.shift()?.();
    }
  }
}

const QUAL_ITEMS = 6;
const QUAL_TTL_MS = 30 * 60_000;
const QUAL_RETRY_MS = 2 * 60_000;
const QUAL_MAX_PRICE = 1_000_000n;

/** The creator's share of `basis` at `bps` basis points, rounded down to the tinybar. */
export const royaltyOf = (basis: bigint, bps: number) => (basis * BigInt(bps)) / 10_000n;

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
