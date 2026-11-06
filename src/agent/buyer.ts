import { randomBytes } from "node:crypto";
import { splitIntoChunks } from "../core/chunker.js";
import { attrBig, attrStr, TTL } from "../integrations/arkiv.js";
import { agentProfile, uaidFor, uaidKey, verifyUaid, type AgentProfile } from "../integrations/identity.js";
import type { Services } from "../integrations/index.js";
import { BudgetExceededError, PaymentInFlightError, payFetch, type PaymentSigner } from "../integrations/x402.js";
import { attestable, serviceKind, zeroGDirectory } from "../integrations/zerog-compute.js";
import { formatHbar, HBAR, type ChunkRequest, type ChunkResponse, type Item, type ItemOutput, type Offer, type PaymentAsset, type ProviderRank, type ResultVerdict, type SlashOutcome, type TaskKind, type TaskSpec } from "../types.js";
import type { Qualification } from "../verifier/verifier.js";
import { commitData, encryptJson, deriveKey, randomKey, sealString, toBase64 } from "../util/crypto.js";
import { wrapContext, wrapKey } from "../util/wrap.js";
import { logger, type Logger } from "../util/log.js";
import { executionHash, recoverResultSigner, signedPost, signedRequest } from "../util/sign.js";
import { buildPassportBody, passportDigest, signPassport, type Attestation, type Passport, type PassportAnchor, type PassportBody, type PassportCanary, type PassportKnown, type PassportModel, type PassportSpot, type PassportWork } from "./passport.js";
import { describeAgreement, makeAgreement, taskHash, type Agreement, type AgreementInput, type ModelTerms } from "../core/agreement.js";
import type { ModelListing } from "../models/registry.js";
import { TIER_RULES, type Tier } from "../core/tiers.js";
import { guaranteeOf } from "./assurance.js";
import { makeQuote } from "../core/quote.js";
import type { Outcome } from "./passport.js";
import { MIN_CHECKS_TO_SKIP, parseStrategy, rankOffers, recordFromChecks, reliabilityOf, type Strategy, type TrackRecord } from "./ranking.js";

export interface BuyerPolicy {
  /** Highest x402 quote the agent will pay for one chunk. */
  maxPricePerChunk: bigint;
  /** Hard cap on what one job may spend. */
  maxJobSpend: bigint;
  /** Optional allowlist of provider EVM addresses. */
  allowlist?: string[];
  /** Consecutive transport failures before a provider is treated as offline. */
  offlineAfter?: number;
  requestTimeoutMs?: number;
  /** How offers are ranked: by price, track record and speed, weighted per strategy. Default balanced. */
  strategy?: Strategy;
  /** Work with at most this many providers at once; the next best wait as reserves. Default: all. */
  maxProviders?: number;
  /** Skip providers whose estimated reliability (0..1) is below this, once they have enough history. */
  minReliability?: number;
  /** Only work with providers whose 0G Compute provider can be TEE-attested (checked on the 0G chain). */
  requireAttestation?: boolean;
  /** Send unwrapped chunk keys to providers that publish no encryption key (off by default). */
  allowPlainKeys?: boolean;
  /** The user's own 0G API key (Sign in with 0G): the verifier bills this job's 0G checks to it. */
  zerogKey?: string;
}

/** Provider-choice settings from AGENT_STRATEGY, AGENT_MAX_PROVIDERS and AGENT_MIN_RELIABILITY. */
export function choiceFromEnv(env: Record<string, string | undefined> = process.env): Pick<BuyerPolicy, "strategy" | "maxProviders" | "minReliability" | "requireAttestation" | "allowPlainKeys"> {
  return {
    strategy: parseStrategy(env.AGENT_STRATEGY || undefined),
    ...(env.AGENT_MAX_PROVIDERS ? { maxProviders: Number(env.AGENT_MAX_PROVIDERS) } : {}),
    ...(env.AGENT_MIN_RELIABILITY ? { minReliability: Number(env.AGENT_MIN_RELIABILITY) } : {}),
    ...(env.AGENT_REQUIRE_ATTESTATION === "true" ? { requireAttestation: true } : {}),
    ...(env.AGENT_ALLOW_PLAIN_KEYS === "true" ? { allowPlainKeys: true } : {}),
  };
}

export interface JobInput {
  task: TaskSpec;
  items: Item[];
  chunkSize: number;
  /** Rules for this job, agreed with the verifier before any chunk runs. */
  agreement?: AgreementInput;
  /**
   * A listed model to run (from the model registry): only providers serving it are used, every
   * chunk is signed for it, and its creator is paid a royalty on the accepted chunks.
   */
  model?: ModelListing;
}

export interface ProviderReport {
  name: string;
  provider: string;
  priceTinybar: bigint;
  /** "reserve": admitted and ranked, but never needed in this job. */
  status: "active" | "offline" | "slashed" | "capped" | "quarantined" | "unqualified" | "reserve";
  payTo?: string;
  uaid?: string;
  gpu?: string;
  /** The model backend the provider declares. */
  backend?: string;
  /** The 0G Compute provider it runs on, when it calls one directly. */
  zgProvider?: string;
  /** From the 0G chain: whether that 0G provider can be attested, and whether it runs the model itself or relays it. */
  attestable?: boolean;
  providerType?: "decentralized" | "centralized";
  providerIdentity?: string;
  /** How an adversarial test provider says it cheats. */
  adversarial?: string;
  rank?: ProviderRank;
  /** Started as a reserve and stepped in when another provider dropped out. */
  promoted?: boolean;
  /** Admission check before any paid work, and the model check when the verifier has fingerprints for its declared model. */
  qualification?: { admitted: boolean; agreement: number; latencyMs: number; reason?: string; skipped?: boolean; fingerprint?: { declared: string; verdict: "consistent" | "mismatch" | "inconclusive"; match: number; closest?: string } };
  served: number;
  kept: number;
  paidTinybar: bigint;
  refundTinybar: bigint;
  /** Paid (settled on the ledger) but the response never arrived. Included in paidTinybar. */
  undeliveredTinybar: bigint;
  /** The transaction that paid the refund (the slash proposal while it is still open). */
  vaultTx?: string;
  /** The vault's slash id, where it stands, and the verifiers whose signatures carried it. */
  slashId?: string;
  slashStatus?: SlashOutcome["status"];
  slashSigners?: string[];
  /** The rest of its bond, burned when the slash executed. */
  burnedTinybar?: bigint;
}

export interface JobReport {
  jobId: string;
  status: "complete" | "incomplete";
  chunks: number;
  completed: number;
  rerouted: number;
  /** Unverified chunks from quarantined providers that were re-run elsewhere. */
  rechecked: number;
  canaryFailures: number;
  /** What x402 payments settled in. `paidTinybar` and the fee are in its smallest unit. */
  asset: PaymentAsset;
  paidTinybar: bigint;
  /** Always HBAR: refunds come out of the provider's bond in the vault. */
  refundedTinybar: bigint;
  /** A model job: the royalty paid to the model's creator, on the accepted chunks only. */
  royaltyTinybar?: bigint;
  /** A model job: the model, its passport and the royalty payment. */
  model?: PassportModel;
  /** x402 fee paid to the verifier for checking this job. */
  verificationFeeTinybar: bigint;
  verificationFeeTx?: string;
  /** Public (unencrypted) Swarm reference to the job's Compute Passport (formerly the audit bundle). */
  auditRef: string;
  auditUrl: string;
  /** The signed Compute Passport. `attested` is true when the verifier co-signed it. */
  passport: { ref: string; url: string; digest: string; attested: boolean; coverage: PassportBody["coverage"] };
  strategy: Strategy;
  /** The rules agreed before work, and whether the job met them. */
  agreement: Agreement;
  outcome: Outcome;
  providers: ProviderReport[];
  commitment: string;
  canaries: number[];
  results: ItemOutput[];
}

type ChunkStatus = "pending" | "claimed" | "done" | "verified";

interface ChunkState {
  idx: number;
  key?: string;
  status: ChunkStatus;
  provider?: string;
  avoid: Set<string>;
  /** 0G Compute providers that already failed this chunk: it goes to one that is independent of them. */
  avoidUpstream: Set<string>;
  swarmRef: string;
  encRef: string;
  result?: ItemOutput[];
  /** Evidence for the accepted result, for the Compute Passport. */
  work?: PassportWork;
  /** High assurance: each provider's accepted copy, until the verifier says two agree. */
  copies: Map<string, { result: ItemOutput[]; work: PassportWork }>;
}

interface ProviderRun {
  offer: Offer;
  status: ProviderReport["status"];
  paid: bigint;
  served: number;
  failures: number;
  completed: Set<number>;
  refund: bigint;
  undelivered: bigint;
  canaryFails: number;
  inFlight: { paymentId: string; amount: bigint }[];
  vaultTx?: string;
  slash?: SlashOutcome;
  promoted?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ranked offers, reordered so the working set spans as many 0G Compute providers as it can:
 * the best offer on each 0G provider first, then the rest, each group in rank order. Two
 * KINETIC providers on the same 0G provider fail together, so the second waits as a reserve.
 */
export function spreadUpstreams(offers: Offer[]): Offer[] {
  const seen = new Set<string>();
  const first: Offer[] = [];
  const rest: Offer[] = [];
  for (const o of offers) {
    if (o.zgProvider && seen.has(o.zgProvider)) rest.push(o);
    else {
      if (o.zgProvider) seen.add(o.zgProvider);
      first.push(o);
    }
  }
  // Within each group, offers whose 0G provider can be TEE-attested go first (stable, so rank order holds).
  const attestedFirst = (list: Offer[]) => [...list.filter((o) => o.attestable), ...list.filter((o) => !o.attestable)];
  return [...attestedFirst(first), ...attestedFirst(rest)];
}

export class BuyerAgent {
  private readonly signer: PaymentSigner;
  private halted = false;

  constructor(
    private readonly svc: Services,
    private readonly verifierUrl: string,
    private readonly policy: BuyerPolicy,
    private readonly log: Logger = logger("buyer"),
  ) {
    this.signer = svc.payer();
  }

  /**
   * Offers on Arkiv that can run this task, are bonded in the vault, not slashed, and within
   * budget, ranked best first by the policy's strategy (price, the verifier's track record of
   * each provider, and measured speed).
   */
  async discover(kind: TaskKind, tier: Tier = "standard", model?: string): Promise<Offer[]> {
    const status = (await (await fetch(`${this.verifierUrl}/status`)).json()) as { verifier: string };
    const [offers, reputations] = await Promise.all([
      // A model job only looks at providers that serve that model.
      this.svc.arkiv.query("offer", { [`task.${kind}`]: 1, ...(model ? { [`model.${model}`]: 1 } : {}) }),
      // Created by the verifier (the creator never changes) and still owned by it, so only it can have patched them.
      this.svc.arkiv.query("reputation", {}, { owner: status.verifier, creator: status.verifier }),
    ]);
    const slashed = new Set(reputations.filter((r) => attrStr(r, "status") === "slashed").map((r) => attrStr(r, "provider")));
    const records = new Map<string, TrackRecord>(
      reputations.map((r) => [attrStr(r, "provider"), { pass: Number(attrBig(r, "pass")), fail: Number(attrBig(r, "fail")), latencyMs: Number(attrBig(r, "latency_ms")) || undefined }]),
    );
    // The live record wins: a count of the verifier's unexpired check entities, so old results
    // age out by themselves. Latency still comes from the reputation.
    await Promise.all(
      [...new Set(offers.map((e) => attrStr(e, "provider")))].map(async (provider) => {
        const live = await this.liveRecord(provider, status.verifier).catch(() => undefined);
        if (live) records.set(provider, { ...live, latencyMs: records.get(provider)?.latencyMs });
      }),
    );
    // Each offer is checked independently (identity, then the bond on Hedera), in parallel:
    // the relay can take seconds per read.
    // One offer per provider: a restarted node publishes a new offer before its old one expires.
    const newest = new Map<string, (typeof offers)[number]>();
    for (const e of offers) {
      const p = attrStr(e, "provider");
      const seen = newest.get(p);
      if (!seen || (e.expiresAt ?? 0n) > (seen.expiresAt ?? 0n)) newest.set(p, e);
    }
    const checked = await Promise.all(
      [...newest.values()].map(async (e): Promise<Offer | null> => {
        const provider = attrStr(e, "provider");
        // Only the provider can publish its own offer: it created it (an offer someone else created
        // and handed over doesn't count) and still owns it (so nobody else can have patched it).
        if (e.owner !== provider || (e.creator ?? e.owner) !== provider) return null;
        if (slashed.has(provider)) return null;
        if (this.policy.allowlist && !this.policy.allowlist.includes(provider)) return null;
        const price = attrBig(e, "price");
        if (price > this.policy.maxPricePerChunk) return null;
        const record = records.get(provider);
        if (this.policy.minReliability && record && record.pass + record.fail >= MIN_CHECKS_TO_SKIP && reliabilityOf(record) < this.policy.minReliability) {
          this.log(`skipping ${attrStr(e, "name")}: reliability ${reliabilityOf(record).toFixed(2)} over ${record.pass + record.fail} checks is below ${this.policy.minReliability}`);
          return null;
        }
        // Chunk keys go to a provider only wrapped to its own public key, unless the buyer allows otherwise.
        if (!this.policy.allowPlainKeys && !(e.payload as { encKey?: string } | null)?.encKey) {
          this.log(`skipping ${attrStr(e, "name")}: its offer publishes no encryption key for chunk keys`);
          return null;
        }
        if (!(await this.identityMatches(e, provider))) {
          this.log(`skipping offer ${attrStr(e, "name")}: its HCS-14 UAID doesn't match its profile`);
          return null;
        }
        const bond = await this.svc.vault.bondOf(provider);
        if (bond.slashed || bond.amountTinybar === 0n) return null;
        // A provider that asked for its bond back could take it out mid-job, ahead of a slash.
        if (bond.unlockAt !== 0) {
          this.log(`skipping ${attrStr(e, "name")}: it has asked to withdraw its bond`);
          return null;
        }
        return {
          key: e.key,
          provider,
          payTo: attrStr(e, "pay_to"),
          name: attrStr(e, "name"),
          endpoint: attrStr(e, "endpoint"),
          gpu: attrStr(e, "gpu"),
          tasks: [kind],
          priceTinybar: price,
          bondTinybar: bond.amountTinybar,
          uaid: (e.payload as { uaid?: string } | null)?.uaid,
          backend: (e.payload as { backend?: string } | null)?.backend,
          encKey: (e.payload as { encKey?: string } | null)?.encKey,
          adversarial: attrStr(e, "adversarial") || undefined,
          zgProvider: attrStr(e, "zg_provider").toLowerCase() || undefined,
          models: ((e.payload as { models?: { key: string }[] } | null)?.models ?? []).map((m) => m.key),
          sandbox: attrStr(e, "sandbox") || undefined,
        };
      }),
    );
    // Whether each 0G Compute provider's responses can be attested, read from the 0G chain, not the offer.
    const withAttestation = await Promise.all(
      checked
        .filter((o): o is Offer => o !== null)
        .map(async (o) => {
          if (!o.zgProvider) return o;
          const svc = await zeroGDirectory(this.svc.cfg)
            .get(o.zgProvider)
            .catch(() => undefined);
          if (!svc) {
            this.log(`skipping ${o.name}: its 0G provider ${o.zgProvider} is not registered on the 0G chain`);
            return null;
          }
          return { ...o, attestable: attestable(svc), verifiability: svc.verifiability, ...serviceKind(svc) };
        }),
    );
    const usable = withAttestation.filter((o): o is Offer => {
      if (!o) return false;
      if (this.policy.requireAttestation && !o.attestable) {
        this.log(`skipping ${o.name}: its 0G provider's responses can't be attested`);
        return false;
      }
      // Confidential assurance: only 0G services whose TEE signs every response, on a 0G node.
      if (TIER_RULES[tier].attested && !(o.attestable && guaranteeOf(o.verifiability, o.providerType) === "TeeML")) {
        this.log(`skipping ${o.name} for confidential assurance: it doesn't run on an attestable TeeML 0G node`);
        return false;
      }
      return true;
    });
    return rankOffers(usable, records, this.policy.strategy ?? "balanced");
  }

  /** Kill switch: no new paid work starts after this. Chunks already in flight finish. */
  halt(): void {
    this.halted = true;
    this.log("halted: no new paid requests");
  }

  async run(input: JobInput, hooks: { onJob?: (jobId: string) => void } = {}): Promise<JobReport> {
    const { task, model } = input;
    if (model && taskHash(model.card.task) !== taskHash(task)) throw new Error(`${model.id}@${model.version} does the task in its card; run it with that task`);
    const jobId = `job-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    hooks.onJob?.(jobId);
    const jobKey = randomKey();
    const refKey = deriveKey(jobKey, "ref");
    const resultKey = deriveKey(jobKey, "result");
    const arkiv = this.svc.arkiv;
    const background = (p: Promise<unknown>) => p.catch((err) => this.log("arkiv write failed", { error: (err as Error).message }));

    // 0. Look at the market first: which providers could do this work, and at what prices.
    const tier = input.agreement?.tier ?? "standard";
    const discovered = await this.discover(task.kind, tier, model?.key);
    if (discovered.length === 0) throw new Error(`no bonded providers offer ${model ? `${model.id}@${model.version}` : task.kind} within the price limit${tier === "confidential" ? " on attestable TeeML 0G nodes" : ""}`);
    this.log(`found ${discovered.length} providers on Arkiv`, { providers: discovered.map((o) => `${o.name}@${o.priceTinybar}`) });
    const parts = splitIntoChunks(input.items, input.chunkSize);

    // 1. The rules for this job, set before any work: how much is checked, the pass mark, how
    //    providers are admitted, the deadline, and a firm quote from those offers that the
    //    budget never exceeds. The verifier commits to their hash on HCS.
    const status = (await (await fetch(`${this.verifierUrl}/status`)).json()) as { policy: PassportBody["policy"] & { canaryRate: number }; earnings?: { feePerChunkTinybar?: string | number } };
    const base = makeAgreement({
      task,
      policy: status.policy,
      budget: { asset: this.asset().id, maxSpend: this.policy.maxJobSpend.toString(), maxPricePerChunk: this.policy.maxPricePerChunk.toString() },
      input: input.agreement,
    });
    const quote = makeQuote({
      chunks: parts.length,
      prices: discovered.map((o) => o.priceTinybar),
      feePerChunk: BigInt(status.earnings?.feePerChunkTinybar ?? 0),
      canaryRate: base.canaryRate,
      protocolRate: status.policy.canaryRate,
      tier,
      royaltyBps: model?.card.royaltyBps,
    });
    const budget = BigInt(quote.total) < this.policy.maxJobSpend ? BigInt(quote.total) : this.policy.maxJobSpend;
    // A model job commits to the model and its creator's terms with the rest of the rules.
    const terms: ModelTerms | undefined = model && {
      key: model.key,
      id: model.id,
      version: model.version,
      passport: model.passportDigest,
      passportRef: model.passportRef,
      royaltyBps: model.card.royaltyBps,
      payTo: model.card.creator.payTo,
    };
    const agreement: Agreement = { ...base, budget: { ...base.budget, maxSpend: budget.toString() }, quote, ...(terms ? { model: terms } : {}) };
    if (budget < BigInt(quote.total)) this.log("the budget is below the quote: the job may stop before it finishes", { budget, quote: quote.total });
    const deadline = agreement.deadline ? Date.parse(agreement.deadline) : Infinity;
    let deadlineHit = false;
    const pastDeadline = () => {
      if (!deadlineHit && Date.now() >= deadline) {
        deadlineHit = true;
        this.log("deadline reached: no new paid work");
      }
      return deadlineHit;
    };
    this.log("agreed rules", { rules: describeAgreement(agreement) });

    // 2. Split, encrypt each chunk with its own key, store on Swarm. The reference is sealed
    //    before it goes on Arkiv, because an encrypted Swarm reference carries its own key.
    const chunks: ChunkState[] = [];
    for (let idx = 0; idx < parts.length; idx++) {
      const swarmRef = await this.svc.swarm.upload(encryptJson(deriveKey(jobKey, `chunk:${idx}`), parts[idx]));
      chunks.push({ idx, status: "pending", avoid: new Set(), avoidUpstream: new Set(), swarmRef, encRef: sealString(refKey, swarmRef), copies: new Map() });
    }
    this.log(`job ${jobId}: ${input.items.length} items in ${chunks.length} chunks uploaded to Swarm`);

    // 3. Job and chunk state on Arkiv, read live by the dashboard.
    const jobKeyOnArkiv = await arkiv.create({
      kind: "job",
      ttlSeconds: TTL.job,
      attrs: { job_id: jobId, task: task.kind, status: "running", total: chunks.length, done: 0, rerouted: 0, paid: 0, refunded: 0, ...(model ? { model: model.key } : {}) },
      payload: { task: { kind: task.kind, labels: task.labels?.map((l) => l.name), fields: task.fields?.map((f) => f.name) }, chunkSize: input.chunkSize, ...(model ? { model: { key: model.key, id: model.id, version: model.version, name: model.name } } : {}) },
    });
    await Promise.all(
      chunks.map(async (c) => {
        // job_key links each chunk to its job entity (a typed Arkiv `key`).
        c.key = await arkiv.create({ kind: "chunk", ttlSeconds: TTL.job, attrs: { job_id: jobId, job_key: jobKeyOnArkiv, idx: c.idx, status: "pending", provider: "" }, payload: { encRef: c.encRef } });
      }),
    );

    // 4. Register with the verifier (an x402 payment: its fee per chunk). It commits to its
    //    hidden canary set and the agreed rules on HCS before any chunk runs.
    const registration = await payFetch(
      `${this.verifierUrl}/jobs`,
      await signedRequest(this.svc.account, {
        jobId,
        buyer: this.svc.address,
        task,
        chunks: chunks.map((c) => ({ idx: c.idx, swarmRef: c.swarmRef, itemIds: parts[c.idx].map((i) => i.id) })),
        jobKey: toBase64(jobKey),
        agreement,
        ...(agreement.admission.source === "buyer" ? { goldSet: input.agreement?.goldSet } : {}),
        ...(model ? { model: { key: model.key, passport: model.passportDigest } } : {}),
        ...(this.policy.zerogKey ? { zerogKey: this.policy.zerogKey } : {}),
      }),
      this.signer,
      budget,
    );
    if (!registration.response.ok) throw new Error(`verifier /jobs failed (${registration.response.status}): ${await registration.response.text()}`);
    const reg = (await registration.response.json()) as { commitment: string; canaries: number; known?: string; chunks?: { idx: number; swarmRef: string; itemIds: string[] }[] };
    const fee = registration.settlement?.success ? BigInt(registration.requirements!.amount) : 0n;
    const feeTx = registration.settlement?.transaction;
    this.log(`verifier committed to hidden canaries`, { commitment: reg.commitment, fee, feeTx, ...(reg.known ? { knownAnswers: "planted in every chunk" } : {}) });
    // The verifier planted a known answer in each chunk and stored it again under the chunk's
    // own key. Providers get the new chunk; the planted items never reach the results.
    for (const c of reg.chunks ?? []) {
      const chunk = chunks[c.idx];
      const mine = new Set(parts[c.idx].map((i) => i.id));
      if (!chunk || parts[c.idx].some((i) => !c.itemIds.includes(i.id)) || c.itemIds.length > mine.size + 4) throw new Error(`verifier returned a chunk #${c.idx} that doesn't hold this job's items`);
      chunk.swarmRef = c.swarmRef;
      chunk.encRef = sealString(refKey, c.swarmRef);
      background(arkiv.patch(chunk.key!, {}, { encRef: chunk.encRef }));
    }

    // 5. Dispatch: one sequential worker per provider pulling from a shared queue.
    // Evaluate before assigning work: the verifier probes each provider with a paid chunk of
    // known-answer tickets. Only admitted providers get paid work in this job.
    const qualifications = new Map<string, Qualification>();
    await Promise.all(
      discovered.map(async (o) => {
        const q = await this.verifierCall<Qualification>("/qualify", { provider: o.provider, endpoint: o.endpoint, payTo: o.payTo, task, jobId, ...(model ? { model: model.key } : {}) }).catch(
          (err: Error): Qualification => ({ provider: o.provider, admitted: false, agreement: 0, formatOk: false, latencyMs: 0, checkedAt: Date.now(), reason: err.message }),
        );
        qualifications.set(o.provider, q);
        this.log(`${o.name} ${q.admitted ? "admitted" : "not admitted"}`, { knownAnswers: `${Math.round(q.agreement * 100)}%`, latencyMs: q.latencyMs, reason: q.reason });
      }),
    );
    const offers = spreadUpstreams(discovered.filter((o) => qualifications.get(o.provider)?.admitted));
    const unqualified = discovered.filter((o) => !qualifications.get(o.provider)?.admitted);
    if (offers.length === 0) throw new Error("no provider passed qualification");
    if (offers.length < TIER_RULES[tier].copies) throw new Error(`${tier} assurance needs at least ${TIER_RULES[tier].copies} independent providers; ${offers.length} passed qualification`);

    // Choose: the best-ranked admitted providers work; the next best wait as reserves.
    const limit = Math.max(1, Math.floor(this.policy.maxProviders ?? offers.length));
    const reserves = offers.slice(limit);
    const runs = new Map<string, ProviderRun>();
    const addRun = (o: Offer, promoted = false): ProviderRun => {
      const run: ProviderRun = { offer: o, status: "active", paid: 0n, served: 0, failures: 0, completed: new Set(), refund: 0n, undelivered: 0n, inFlight: [], canaryFails: 0, promoted };
      runs.set(o.provider, run);
      return run;
    };
    for (const o of offers.slice(0, limit)) addRun(o);
    const describe = (o: Offer) => `${o.name} (${o.rank?.score.toFixed(2) ?? "?"})`;
    this.log(`${this.policy.strategy ?? "balanced"} ranking: working with ${offers.slice(0, limit).map(describe).join(", ")}${reserves.length ? `; reserves ${reserves.map(describe).join(", ")}` : ""}`);
    const queue: number[] = chunks.map((c) => c.idx);
    // What provider payments may use: the budget less the fee, less room for the creator's
    // royalty on everything paid (royalties are only owed on accepted chunks, so this is a ceiling).
    const workCap = model ? ((budget - fee) * 10_000n) / (10_000n + BigInt(model.card.royaltyBps)) : budget - fee;
    let spent = 0n;
    let refunded = 0n;
    let rerouted = 0;
    let canaryFailures = 0;
    let unscored = 0;
    let budgetHit = false;
    const doneCount = () => chunks.filter((c) => c.status === "done" || c.status === "verified").length;
    const activeCount = () => [...runs.values()].filter((r) => r.status === "active").length;

    const setChunk = (c: ChunkState, status: ChunkStatus, provider = "") => {
      c.status = status;
      c.provider = provider || undefined;
      background(arkiv.patch(c.key!, { status, provider }));
    };
    const requeue = (c: ChunkState, front = true) => {
      c.result = undefined;
      c.work = undefined;
      setChunk(c, "pending");
      if (front) queue.unshift(c.idx);
      else queue.push(c.idx);
    };
    const updateJob = (status = "running") =>
      background(arkiv.patch(jobKeyOnArkiv, { status, done: doneCount(), rerouted, paid: spent, refunded, fee }));

    // A chunk that failed on a 0G Compute provider only goes to a provider on a different one.
    const mayTake = (run: ProviderRun, c: ChunkState) => !c.avoid.has(run.offer.provider) && !(run.offer.zgProvider && c.avoidUpstream.has(run.offer.zgProvider));
    const take = (run: ProviderRun): ChunkState | undefined => {
      const pos = queue.findIndex((idx) => mayTake(run, chunks[idx]));
      return pos < 0 ? undefined : chunks[queue.splice(pos, 1)[0]];
    };
    const avoidUpstream = (c: ChunkState, offer: Offer, why: string) => {
      if (!offer.zgProvider || c.avoidUpstream.has(offer.zgProvider)) return;
      c.avoidUpstream.add(offer.zgProvider);
      this.log(`chunk #${c.idx}: 0G provider ${offer.zgProvider} (via ${offer.name}) ${why}; it goes to an independent 0G provider next`);
    };

    const worker = async (run: ProviderRun) => {
      const { offer } = run;
      while (run.status === "active" && !budgetHit && !this.halted && doneCount() < chunks.length && !pastDeadline()) {
        const chunk = take(run);
        if (!chunk) {
          // Nothing this provider may take. Wait only while another worker could still hand chunks back.
          if (chunks.every((c) => c.status !== "claimed")) break;
          await sleep(100);
          continue;
        }
        if (run.paid + offer.priceTinybar > offer.bondTinybar) {
          // Never let unverified spend at one provider exceed what its bond can refund.
          run.status = "capped";
          queue.unshift(chunk.idx);
          break;
        }
        // The firm quote is a hard ceiling: never pay past it.
        const remaining = workCap - spent;
        if (remaining < offer.priceTinybar) {
          budgetHit = true;
          queue.unshift(chunk.idx);
          break;
        }

        setChunk(chunk, "claimed", offer.provider);
        const claim = arkiv.create({ kind: "claim", ttlSeconds: TTL.claim, attrs: { job_id: jobId, idx: chunk.idx, provider: offer.provider } });
        // Arkiv is coordination state: a failed claim write must never take the job down.
        claim.catch((err) => this.log("arkiv claim write failed", { error: (err as Error).message }));
        const releaseClaim = () => background(claim.then((k) => arkiv.remove(k)));

        // The chunk key, wrapped so only this provider can open it, and only for this chunk.
        const chunkKey = deriveKey(jobKey, `chunk:${chunk.idx}`);
        const body: ChunkRequest = {
          ...(offer.encKey
            ? { jobId, idx: chunk.idx, task, swarmRef: chunk.swarmRef, wrappedKey: wrapKey(offer.encKey, chunkKey, wrapContext(jobId, chunk.idx, offer.provider)) }
            : { jobId, idx: chunk.idx, task, swarmRef: chunk.swarmRef, chunkKey: toBase64(chunkKey) }),
          ...(model ? { model: model.key } : {}),
        };
        let response: (ChunkResponse & { payment?: unknown }) | undefined;
        let paidTx: string | undefined;
        let paidAmount = 0n;
        const requestStarted = Date.now();
        try {
          const paid = await payFetch(
            `${offer.endpoint}/v1/chunks`,
            { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.policy.requestTimeoutMs ?? 60_000) },
            this.signer,
            remaining < this.policy.maxPricePerChunk ? remaining : this.policy.maxPricePerChunk,
          );
          if (paid.response.ok && paid.settlement?.success) {
            response = (await paid.response.json()) as ChunkResponse;
            paidTx = paid.settlement.transaction;
            paidAmount = BigInt(paid.requirements!.amount);
            spent += BigInt(paid.requirements!.amount);
            run.paid += BigInt(paid.requirements!.amount);
            run.served += 1;
          } else {
            const why = await paid.response.text().catch(() => "");
            // The provider says its 0G Compute provider failed, not itself: reroute around that 0G provider.
            const upstream = paid.response.status === 502 && /"error":"upstream_failed"/.test(why);
            throw Object.assign(new Error(`provider answered ${paid.response.status}${why ? `: ${why.slice(0, 160)}` : ""}`), { upstream });
          }
        } catch (err) {
          releaseClaim();
          if (err instanceof BudgetExceededError) {
            run.status = "capped";
            requeue(chunk);
            break;
          }
          // The payment left but no answer came back: settle the question against the ledger later.
          if (err instanceof PaymentInFlightError) run.inFlight.push({ paymentId: err.paymentId, amount: err.amount });
          run.failures += 1;
          requeue(chunk);
          this.log(`${offer.name} failed chunk #${chunk.idx}, rerouting`, { error: (err as Error).message, strikes: run.failures });
          if ((err as { upstream?: boolean }).upstream) avoidUpstream(chunk, offer, "failed it");
          if (run.failures >= (this.policy.offlineAfter ?? 2)) {
            run.status = "offline";
            this.log(`${offer.name} marked offline`);
          }
          continue;
        }
        run.failures = 0;
        releaseClaim();

        const signer = await recoverResultSigner(response.jobId, response.idx, response.resultHash, response.signature as `0x${string}`, executionHash(response.execution), response.model);
        if (signer !== offer.provider || response.idx !== chunk.idx || (model && response.model !== model.key)) {
          this.log(`${offer.name} returned an unsigned or mismatched result for #${chunk.idx}`);
          chunk.avoid.add(offer.provider);
          requeue(chunk, false);
          continue;
        }

        const verdict = await this.verifierCall<ResultVerdict>(`/jobs/${jobId}/results`, {
          response: {
            jobId: response.jobId,
            idx: response.idx,
            result: response.result,
            resultHash: response.resultHash,
            provider: response.provider,
            signature: response.signature,
            ...(response.execution ? { execution: response.execution, rawResponse: response.rawResponse } : {}),
            ...(response.model ? { model: response.model } : {}),
          },
          payment: { tx: paidTx, amountTinybar: offer.priceTinybar.toString(), payTo: offer.payTo },
          latencyMs: Date.now() - requestStarted,
        });

        if (verdict.verdict === "accepted" || verdict.verdict === "canary_pass") {
          // Planted known answers stay out of the results; the passport keeps them, by position,
          // so anyone can still recompute the hash the provider signed.
          const mine = new Set(parts[chunk.idx].map((i) => i.id));
          const own = response.result.items.filter((i) => mine.has(i.id));
          const planted = response.result.items.flatMap((item, at) => (mine.has(item.id) ? [] : [{ at, item }]));
          const work: PassportWork = {
            idx: chunk.idx,
            items: own.length,
            ...(planted.length ? { planted } : {}),
            ...(verdict.known ? { known: { items: verdict.known.items, correct: verdict.known.correct } } : {}),
            // A hiding commitment to what this chunk asked for; only this buyer can open it.
            inputCommitment: commitData(deriveKey(jobKey, "input-commitment"), parts[chunk.idx]),
            ...(verdict.execution?.verifiability ? { verifiability: verdict.execution.verifiability } : {}),
            provider: offer.provider,
            resultHash: response.resultHash,
            signature: response.signature,
            payTx: paidTx,
            amount: paidAmount.toString(),
            check: verdict.verdict === "canary_pass" ? "verified" : "format",
            // Which 0G Compute provider ran it, and the verifier's own attestation check (not the provider's).
            ...(response.execution
              ? { execution: response.execution, attestation: verdict.execution?.attestation ?? "unavailable", ...(verdict.execution?.reason ? { attestationReason: verdict.execution.reason } : {}) }
              : {}),
          };
          if (verdict.reason?.startsWith("0G reference unavailable")) unscored += 1;
          const r = verdict.redundancy;
          if (r && r.state !== "matched") {
            // High assurance: a good copy, but the chunk needs another independent provider to agree.
            chunk.copies.set(offer.provider, { result: own, work });
            chunk.avoid.add(offer.provider);
            this.log(`chunk #${chunk.idx} from ${offer.name}: copy ${r.copies} kept; ${r.state === "awaiting" ? "an independent provider runs it next" : "the copies disagree, a third provider runs it"}`);
            requeue(chunk);
          } else {
            // The kept copy is the verifier's choice: at high assurance, the earlier of the two that agreed.
            const keep = r?.winner && r.winner !== offer.provider ? chunk.copies.get(r.winner) : { result: own, work };
            if (!keep) throw new Error(`verifier kept ${r!.winner}'s copy of chunk #${chunk.idx}, which this buyer doesn't have`);
            const keeper = r?.winner ?? offer.provider;
            chunk.result = keep.result;
            chunk.work = r ? { ...keep.work, redundancy: { with: offer.provider, agreement: r.agreement ?? 1 } } : keep.work;
            (runs.get(keeper) ?? run).completed.add(chunk.idx);
            for (const o of r?.outvoted ?? []) {
              const loser = runs.get(o);
              if (loser) loser.canaryFails += 1;
            }
            if (r) this.log(`chunk #${chunk.idx}: ${offer.name} agrees with ${runs.get(keeper)?.offer.name ?? keeper} (${Math.round((r.agreement ?? 1) * 100)}%)${r.outvoted?.length ? `; outvoted ${r.outvoted.length}` : ""}`);
            setChunk(chunk, verdict.verdict === "canary_pass" ? "verified" : "done", keeper);
            // The encrypted result backup on Swarm is a convenience for the dashboard: never worth failing the job over.
            background(
              this.svc.swarm
                .upload(encryptJson(resultKey, { items: keep.result }))
                .then((resultRef) => arkiv.patch(chunk.key!, {}, { encRef: chunk.encRef, resultRef: sealString(refKey, resultRef) })),
            );
          }
        } else {
          if (verdict.verdict === "canary_fail") {
            canaryFailures += 1;
            run.canaryFails += 1;
          }
          this.log(`chunk #${chunk.idx} from ${offer.name}: ${verdict.verdict}`, { reason: verdict.reason, agreement: verdict.canary?.agreement });
          chunk.avoid.add(offer.provider);
          requeue(chunk, false);
        }

        if (verdict.slash || verdict.provider.status === "slashed") {
          run.status = "slashed";
          if (verdict.slash) {
            run.slash = { ...verdict.slash, refundTinybar: BigInt(verdict.slash.refundTinybar) };
            run.refund = run.slash.refundTinybar;
            run.vaultTx = run.slash.vaultTx;
            // What the slash asks for; settled for certain at finalize.
            refunded += run.refund;
          }
          // Recover: everything this provider delivered in this job goes back on the queue.
          for (const idx of run.completed) {
            requeue(chunks[idx], false);
            chunks[idx].avoid.add(offer.provider);
            rerouted += 1;
          }
          run.completed.clear();
          this.log(`${offer.name} SLASHED: refund ${run.refund} tinybar, ${rerouted} chunks rerouted`, { vaultTx: run.vaultTx });
        }
        updateJob();
      }
    };

    // One worker per provider. When a worker stops with work left (its provider went offline,
    // was slashed or hit its bond cap), the best reserve steps in.
    const working: Promise<void>[] = [];
    let running = 0;
    const launch = (run: ProviderRun) => {
      running += 1;
      working.push(
        worker(run).finally(() => {
          running -= 1;
          promote();
        }),
      );
    };
    const promote = () => {
      while (reserves.length > 0 && running < limit && queue.length > 0 && !budgetHit && !this.halted && !pastDeadline()) {
        const o = reserves.shift()!;
        this.log(`reserve ${describe(o)} steps in`);
        launch(addRun(o, true));
      }
    };
    const drain = async () => {
      while (working.length > 0) await working.shift();
    };
    for (const run of runs.values()) launch(run);
    await drain();

    // Quarantine (job-scoped, reversible): a provider that failed a canary here but wasn't
    // slashed keeps none of its unverified work. Those chunks are redone by providers with a
    // clean record in this job. Verified canaries stand. Slashing is unaffected.
    let rechecked = 0;
    const clean = () => [...runs.values()].filter((r) => r.status === "active" && r.canaryFails === 0);
    // If no working provider has a clean record, a reserve does the recheck.
    const tainted = [...runs.values()].some((x) => x.canaryFails > 0 && x.status !== "slashed" && [...x.completed].some((idx) => chunks[idx].status === "done"));
    if (!this.halted && !pastDeadline() && tainted && clean().length === 0 && reserves.length > 0) addRun(reserves.shift()!, true);
    if (!this.halted && !pastDeadline() && clean().length > 0) {
      for (const r of [...runs.values()].filter((x) => x.canaryFails > 0 && x.status !== "slashed")) {
        let n = 0;
        for (const idx of [...r.completed]) {
          if (chunks[idx].status !== "done") continue;
          r.completed.delete(idx);
          chunks[idx].avoid.add(r.offer.provider);
          requeue(chunks[idx], false);
          n += 1;
        }
        if (r.status === "active") r.status = "quarantined";
        rechecked += n;
        this.log(`${r.offer.name} quarantined for this job after ${r.canaryFails} failed canar${r.canaryFails === 1 ? "y" : "ies"}; ${n} unverified chunks re-run elsewhere`);
      }
      if (rechecked > 0) {
        rerouted += rechecked;
        updateJob();
        for (const r of clean()) launch(r);
        await drain();
      }
    }

    // Reconcile payments whose responses were lost (a provider crashing mid-request).
    for (const run of runs.values()) {
      for (const p of run.inFlight) {
        if (await this.signer.isSettled(p.paymentId)) {
          spent += p.amount;
          run.paid += p.amount;
          run.undelivered += p.amount;
          this.log(`${run.offer.name} kept a payment without delivering`, { paymentId: p.paymentId, amount: p.amount });
        }
      }
    }
    if (activeCount() === 0 && doneCount() < chunks.length) this.log("no active providers left; job incomplete");

    // 6. Reveal canaries, close the job on Arkiv, hand back results.
    const summary = await this.verifierCall<{ commitment: string; canaries: number[]; salt: string; checked?: PassportCanary[]; known?: PassportKnown; anchor?: PassportAnchor; spot?: PassportSpot; slashes?: (Omit<SlashOutcome, "refundTinybar" | "burnedTinybar"> & { refundTinybar: string; burnedTinybar?: string })[] }>(
      `/jobs/${jobId}/finalize`,
      {},
    );
    // Slashes settle after their dispute windows: take the refunds the vault actually paid.
    for (const s of summary.slashes ?? []) {
      const run = runs.get(s.provider);
      if (!run) continue;
      run.slash = { ...s, refundTinybar: BigInt(s.refundTinybar), burnedTinybar: s.burnedTinybar === undefined ? undefined : BigInt(s.burnedTinybar) };
      run.refund = run.slash.status === undefined || run.slash.status === "executed" ? run.slash.refundTinybar : 0n;
      run.vaultTx = run.slash.vaultTx;
    }
    refunded = [...runs.values()].reduce((a, r) => a + r.refund, 0n);

    // A model job: pay the creator's royalty, the agreed share of the payments for the chunks
    // kept. Refunded, rerouted and failed chunks are never in it. The verifier computes it from
    // the chunks it accepted and the creator is paid over x402, straight to their account.
    let royalty: PassportModel["royalty"];
    if (model) {
      const basis = chunks.reduce((a, c) => a + BigInt(c.work?.amount ?? 0), 0n);
      const owed = (basis * BigInt(model.card.royaltyBps)) / 10_000n;
      if (owed > 0n) {
        try {
          const paid = await payFetch(`${this.verifierUrl}/jobs/${jobId}/royalty`, await signedRequest(this.svc.account, {}), this.signer, owed);
          if (paid.response.ok && paid.settlement?.success) {
            const due = (await paid.response.json()) as { amount: string; basis: string };
            royalty = { amount: due.amount, basis: due.basis, tx: paid.settlement.transaction };
            this.log(`royalty paid to the creator of ${model.id}`, { amount: due.amount, payTo: model.card.creator.payTo, tx: royalty.tx });
          } else this.log("royalty payment didn't settle", { status: paid.response.status, body: (await paid.response.text().catch(() => "")).slice(0, 200) });
        } catch (err) {
          this.log("royalty payment failed", { error: (err as Error).message });
        }
      }
    }
    const royaltyPaid = BigInt(royalty?.amount ?? 0);
    const passportModel: PassportModel | undefined = terms && {
      key: terms.key,
      id: terms.id,
      version: terms.version,
      passportRef: terms.passportRef,
      passportDigest: terms.passport,
      royaltyBps: terms.royaltyBps,
      payTo: terms.payTo,
      ...(royalty ? { royalty } : {}),
    };
    const complete = doneCount() === chunks.length;
    // The agreement is met when every chunk finished within the rules (the budget, price cap
    // and pass mark are enforced as the job runs, so nothing outside them was accepted).
    const withinQuote = `paid ${formatHbar(spent + fee + royaltyPaid)} of the ${formatHbar(budget)} quoted`;
    const outcome: Outcome = complete
      ? { met: true, notes: [`all ${chunks.length} chunks finished${agreement.deadline ? " before the deadline" : ""} within the budget`, withinQuote] }
      : {
          met: false,
          notes: [
            `${doneCount()} of ${chunks.length} chunks finished`,
            withinQuote,
            ...(deadlineHit ? ["the deadline passed"] : []),
            ...(budgetHit ? ["the budget ran out"] : []),
            ...(this.halted ? ["stopped by the kill switch"] : []),
            ...(!deadlineHit && !budgetHit && !this.halted ? ["no admitted provider was left"] : []),
          ],
        };
    const qualificationOf = (provider: string) => {
      const q = qualifications.get(provider);
      const fp = q?.fingerprint;
      return q && { admitted: q.admitted, agreement: q.agreement, latencyMs: q.latencyMs, reason: q.reason, skipped: q.skipped, ...(fp ? { fingerprint: { declared: fp.declared, verdict: fp.verdict, match: fp.match, ...(fp.closest ? { closest: fp.closest } : {}) } } : {}) };
    };
    const about = (o: Offer) => ({ payTo: o.payTo, uaid: o.uaid, gpu: o.gpu, backend: o.backend, zgProvider: o.zgProvider, attestable: o.attestable, providerType: o.providerType, providerIdentity: o.providerIdentity, adversarial: o.adversarial, rank: o.rank });
    const providerReports: ProviderReport[] = [
      ...[...runs.values()].map((r) => ({
        name: r.offer.name,
        provider: r.offer.provider,
        priceTinybar: r.offer.priceTinybar,
        status: r.status,
        qualification: qualificationOf(r.offer.provider),
        served: r.served,
        kept: r.completed.size,
        paidTinybar: r.paid,
        refundTinybar: r.refund,
        undeliveredTinybar: r.undelivered,
        vaultTx: r.vaultTx,
        ...(r.slash?.slashId
          ? { slashId: r.slash.slashId, slashStatus: r.slash.status, slashSigners: r.slash.signers, ...(r.slash.burnedTinybar !== undefined ? { burnedTinybar: r.slash.burnedTinybar } : {}) }
          : {}),
        ...about(r.offer),
        ...(r.promoted ? { promoted: true } : {}),
      })),
      ...reserves.map((o) => ({
        name: o.name,
        provider: o.provider,
        priceTinybar: o.priceTinybar,
        status: "reserve" as const,
        qualification: qualificationOf(o.provider),
        served: 0,
        kept: 0,
        paidTinybar: 0n,
        refundTinybar: 0n,
        undeliveredTinybar: 0n,
        ...about(o),
      })),
      ...unqualified.map((o) => ({
        name: o.name,
        provider: o.provider,
        priceTinybar: o.priceTinybar,
        status: "unqualified" as const,
        qualification: qualificationOf(o.provider),
        served: 0,
        kept: 0,
        paidTinybar: 0n,
        refundTinybar: 0n,
        undeliveredTinybar: 0n,
        ...about(o),
      })),
    ];

    // 7. Compute Passport on Swarm: no data and no keys, just hashes, signatures, payments and
    //    check results that anyone can verify (npm run passport:verify). Its reference is public.
    const results = chunks.flatMap((c) => c.result ?? []);
    let body = buildPassportBody({
      jobId,
      network: this.svc.cfg.network,
      buyer: { address: this.svc.address, uaid: await this.uaid() },
      task,
      items: input.items.length,
      chunkSize: input.chunkSize,
      chunks: chunks.length,
      results,
      work: chunks.flatMap((c) => (c.work ? [c.work] : [])),
      canaries: { commitment: summary.commitment, revealed: summary.canaries, salt: summary.salt, checked: summary.checked ?? [], ...(summary.known ? { known: summary.known } : {}) },
      unscoredCanaries: unscored,
      // The verifier's policy, in the order it compares them.
      policy: { canaryRate: status.policy.canaryRate, minAgreement: status.policy.minAgreement, window: status.policy.window, failLimit: status.policy.failLimit },
      payment: this.asset(),
      verificationFee: { tinybar: fee.toString(), ...(feeTx ? { tx: feeTx } : {}) },
      providers: providerReports,
      references: this.references(),
      strategy: this.policy.strategy ?? "balanced",
      agreement,
      outcome,
      ...(passportModel ? { model: passportModel } : {}),
      // The verifier's HCS Merkle anchor over the chunks, and its PRNG spot checks after the job.
      ...(summary.anchor ? { anchor: summary.anchor } : {}),
      ...(summary.spot ? { spot: summary.spot } : {}),
    });
    // The verifier co-signs only what matches its own records. If it refuses, the passport says so.
    let verifierSig: Attestation | undefined;
    try {
      const a = await this.verifierCall<Attestation>(`/jobs/${jobId}/attest`, body);
      verifierSig = { address: a.address, signature: a.signature, ...(a.uaid ? { uaid: a.uaid } : {}) };
    } catch (err) {
      this.log("the verifier did not co-sign the passport", { error: (err as Error).message });
      body = { ...body, limitations: [...body.limitations, `The verifier did not co-sign this passport: ${(err as Error).message.slice(0, 200)}`] };
    }
    const passport: Passport = { ...body, attestations: { buyer: await signPassport(this.svc.account, body), ...(verifierSig ? { verifier: verifierSig } : {}) } };
    const auditRef = await this.svc.swarm.upload(new TextEncoder().encode(JSON.stringify(passport, null, 2)), { encrypt: false, redundancy: this.svc.cfg.swarm.redundancy });
    background(arkiv.patch(jobKeyOnArkiv, { audit_ref: auditRef, ...(royalty ? { royalty: royaltyPaid } : {}) }));
    updateJob(complete ? "complete" : "incomplete");
    await arkiv.flush();

    const report: JobReport = {
      jobId,
      status: complete ? "complete" : "incomplete",
      chunks: chunks.length,
      completed: doneCount(),
      rerouted,
      rechecked,
      canaryFailures,
      asset: this.asset(),
      paidTinybar: spent,
      refundedTinybar: refunded,
      ...(model ? { royaltyTinybar: royaltyPaid, model: passportModel } : {}),
      verificationFeeTinybar: fee,
      verificationFeeTx: feeTx,
      auditRef,
      auditUrl: this.svc.swarm.url(auditRef),
      passport: { ref: auditRef, url: this.svc.swarm.url(auditRef), digest: passportDigest(body), attested: verifierSig !== undefined, coverage: body.coverage },
      strategy: this.policy.strategy ?? "balanced",
      agreement,
      outcome,
      commitment: summary.commitment,
      canaries: summary.canaries,
      providers: providerReports,
      results,
    };
    return report;
  }

  /**
   * HCS-14: the offer's full UAID (payload) must be the hash of the profile it publishes, its
   * key must be the queryable `uaid` attribute, and the profile must name the account the
   * offer is paid at.
   */
  /**
   * A provider's live record from the verifier's unexpired check entities, trusted by creator:
   * checks are created readonly, so what the verifier wrote is what it says. Arkiv sorts and counts
   * them: the newest 100 come back with the total, and only a provider with more needs a count of
   * its passes (and its latest pass, if none of the newest 100 passed).
   */
  private async liveRecord(provider: string, verifier: string): Promise<TrackRecord | undefined> {
    const arkiv = this.svc.arkiv;
    const newest = { creator: verifier, orderBy: { attr: "at", desc: true } };
    const { entities, total } = await arkiv.queryCounted("check", { provider }, { ...newest, limit: 100 });
    const record = recordFromChecks(entities);
    if (!record || total <= entities.length) return record;
    const pass = await arkiv.count("check", { provider, pass: 1 }, { creator: verifier });
    let lastPassAt = record.lastPassAt;
    if (!lastPassAt && pass > 0) {
      const [latest] = await arkiv.query("check", { provider, pass: 1 }, { ...newest, limit: 1 });
      lastPassAt = latest ? Number(latest.attrs.at ?? 0) || undefined : undefined;
    }
    return { ...record, pass, fail: total - pass, ...(lastPassAt ? { lastPassAt } : {}) };
  }

  private async identityMatches(e: { attrs: Record<string, unknown>; payload: unknown }, provider: string): Promise<boolean> {
    const key = attrStr(e as never, "uaid");
    const { profile, uaid } = (e.payload as { profile?: AgentProfile; uaid?: string } | null) ?? {};
    if (!key || !profile || !uaid || uaidKey(uaid) !== key) return false;
    const payTo = attrStr(e as never, "pay_to");
    const expected = this.svc.cfg.network === "testnet" ? `hedera:testnet:${payTo}` : `eip155:296:${provider}`;
    return profile.nativeId === expected && (await verifyUaid(uaid, profile, provider));
  }

  private buyerUaid?: Promise<string>;

  /** The buyer's own HCS-14 UAID, named in its passports. */
  private uaid(): Promise<string> {
    this.buyerUaid ??= uaidFor(
      agentProfile({ role: "buyer", name: "kinetic-buyer", network: this.svc.cfg.network, hederaAccountId: this.svc.identity.hederaAccountId, evmAddress: this.svc.address }),
      this.svc.address,
    );
    return this.buyerUaid;
  }

  /** Where a passport's claims can be checked. */
  private references(): PassportBody["references"] {
    const cfg = this.svc.cfg;
    return {
      x402Network: cfg.x402.network,
      hcsTopic: cfg.hedera.hcsTopicId,
      mirrorUrl: cfg.hedera.mirrorUrl,
      ...(cfg.network === "testnet" && cfg.hedera.vaultAddress ? { vault: cfg.hedera.vaultAddress } : {}),
      swarmGateway: cfg.swarm.gatewayUrl,
      ...(cfg.network === "devnet" ? { devnetUrl: cfg.devnetUrl } : {}),
    };
  }

  /** Payments are HBAR, the same asset as bonds. */
  private asset(): PaymentAsset {
    return HBAR;
  }

  private async verifierCall<T>(path: string, body: unknown): Promise<T> {
    const res = await signedPost(this.svc.account, `${this.verifierUrl}${path}`, body);
    if (!res.ok) throw new Error(`verifier ${path} failed (${res.status}): ${await res.text()}`);
    return (await res.json()) as T;
  }
}
