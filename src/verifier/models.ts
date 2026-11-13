import { readFileSync } from "node:fs";
import { TTL } from "../integrations/arkiv.js";
import type { ReceiptLog } from "../integrations/hcs.js";
import type { Services } from "../integrations/index.js";
import { cardDigest, cardProblems, cardSigner, modelKey, type ModelCard } from "../models/card.js";
import { MODEL_PASSPORT_KIND, modelPassportDigest, modelPassportLimitations, modelPassportSigners, signModelPassport, type ModelFingerprint, type ModelPassport, type ModelPassportBody } from "../models/passport.js";
import { listingAttrs, type ListingPayload } from "../models/registry.js";
import { ModelRejected, reviewModel, type PublishRequest, type Review, type ReviewOptions } from "../models/review.js";
import { logger } from "../util/log.js";
import { stateFile, writeJsonAtomic } from "../util/state.js";

// The verifier's model desk: it issues Model Passports and keeps the listings alive.
//
// A creator sends a signed card (and pays the listing fee over x402). This verifier reviews the
// model itself (malware checks on the weights, benchmark, fingerprint), drafts the passport and
// asks the vault's other verifiers to re-review it on their own and sign. With a quorum of
// signatures, the passport goes to 0G Storage, its digest to HCS, and a `model` listing to Arkiv.
// Listings expire like any Arkiv entity, so the desk renews them, and re-creates one from its
// record if it ever lapses.

/** Another verifier, re-reviewing a model before it signs the passport. */
export interface ModelReviewer {
  attestModel(req: PublishRequest, body: ModelPassportBody): Promise<{ address: string; signature: string }>;
}

export interface ListingRecord extends ListingPayload {
  key: string;
  entityKey: string;
  fingerprint?: ModelFingerprint;
  issuedAt: number;
  renewedAt: number;
  /** The Arkiv chain the listing entity lives on (absent: written before this was kept, on Tiramisu). */
  arkivChainId?: number;
}

/** Records from before arkivChainId was kept were all written to Tiramisu. */
const LEGACY_ARKIV_CHAIN_ID = 7738577;

export interface ModelDeskOptions {
  svc: Services;
  receipts: ReceiptLog;
  review: ReviewOptions;
  reviewers: ModelReviewer[];
}

/** Where a model's review stands. Reviews run in the background: on real networks they take minutes. */
export interface ReviewStatus {
  key: string;
  id: string;
  version: string;
  status: "reviewing" | "listed" | "refused";
  startedAt: number;
  finishedAt?: number;
  reasons?: string[];
  listing?: { passportRef: string; passportDigest: string; accuracy: number; signers: string[]; entityKey: string };
  /** Each step of the review as it happens, for the dashboard's publish screen. */
  steps: ReviewStep[];
}

export interface ReviewStep {
  step: "lead" | "cosigner" | "passport" | "hcs" | "arkiv";
  at: number;
  ok: boolean;
  /** Who: the verifier's address, for lead and cosigner steps. */
  by?: string;
  detail?: string;
  /** 0G Storage root, HCS sequence number or Arkiv entity key. */
  ref?: string;
}

/** Renew a listing once a day: far inside its 30-day lifetime. */
const RENEW_EVERY_MS = 24 * 3600_000;

export class ModelDesk {
  private readonly listings = new Map<string, ListingRecord>();
  private readonly reviews = new Map<string, ReviewStatus>();
  private readonly log = logger("models");
  private renewal?: Promise<void>;

  constructor(private readonly opts: ModelDeskOptions) {
    const file = this.file;
    if (!file) return;
    try {
      for (const r of JSON.parse(readFileSync(file, "utf8")) as ListingRecord[]) this.listings.set(r.key, r);
      if (this.listings.size > 0) this.log(`restored ${this.listings.size} model listing(s)`);
    } catch {
      // Nothing listed yet.
    }
  }

  private get file(): string | undefined {
    return stateFile(this.opts.svc.cfg, `verifier-${this.opts.svc.address}`, "models.json");
  }

  private save(): void {
    const file = this.file;
    if (file) writeJsonAtomic(file, [...this.listings.values()]);
  }

  get(key: string): ListingRecord | undefined {
    return this.listings.get(key);
  }

  list(): ListingRecord[] {
    return [...this.listings.values()];
  }

  /**
   * The quick checks before the listing fee settles: a complete card, signed by its creator, sent
   * by its creator, and not already listed or under review. Returns the model's key.
   */
  async admit(req: PublishRequest, signer: string): Promise<string> {
    const card = req?.card as ModelCard;
    const problems = cardProblems(card);
    if (problems.length > 0) throw new ModelRejected(problems);
    if (signer.toLowerCase() !== card.creator.address) throw new ModelRejected(["only the card's creator can publish it"]);
    if ((await cardSigner(card, req.signature)) !== card.creator.address) throw new ModelRejected(["the card isn't signed by its creator"]);
    const key = modelKey(card.id, card.version);
    if (this.listings.has(key)) throw new ModelRejected([`${card.id}@${card.version} is already listed: a version can't change, publish a new one`]);
    if (this.reviews.get(key)?.status === "reviewing") throw new ModelRejected([`${card.id}@${card.version} is already under review`]);
    // The same weights can't be listed again by someone else: that would let anyone re-upload a
    // creator's model under their own card and take its royalties. The creator may reuse them.
    const taken = this.weightsOwner(card);
    if (taken) throw new ModelRejected([`${taken.file} is already listed as ${taken.id} by another creator`]);
    return key;
  }

  /** Starts the full review in the background (once the listing fee settled); poll it with review(). */
  start(req: PublishRequest, signer: string): ReviewStatus {
    const key = modelKey(req.card.id, req.card.version);
    const status: ReviewStatus = { key, id: req.card.id, version: req.card.version, status: "reviewing", startedAt: Date.now(), steps: [] };
    this.reviews.set(key, status);
    this.publish(req, signer, (s) => status.steps.push({ ...s, at: Date.now() })).then(
      (r) => Object.assign(status, { status: "listed", finishedAt: Date.now(), listing: { passportRef: r.passportRef, passportDigest: r.passportDigest, accuracy: r.accuracy, signers: r.signers, entityKey: r.entityKey } }),
      (err: Error & { reasons?: string[] }) => {
        // No reasons: the review itself broke (a network call, say), which is no verdict on the model.
        const cause = (err.cause as Error | undefined)?.message;
        const reasons = err.reasons ?? [`the review couldn't finish: ${err.message}${cause ? ` (${cause})` : ""}`];
        Object.assign(status, { status: "refused", finishedAt: Date.now(), reasons });
        this.log(`refused ${req.card.id}@${req.card.version}`, { reasons: reasons.slice(0, 3), ...(err.reasons ? {} : { stack: err.stack?.split("\n").slice(1, 4).join(" | ") }) });
      },
    );
    return status;
  }

  /** A safetensors file in this card that another creator's listing already has, by sha256. */
  private weightsOwner(card: ModelCard): { file: string; id: string } | undefined {
    const mine = new Map((card.weights?.files ?? []).filter((f) => /\.safetensors$/i.test(f.name)).map((f) => [f.sha256, f.name]));
    for (const l of this.listings.values()) {
      if (l.card.creator.address === card.creator.address) continue;
      for (const f of l.card.weights?.files ?? []) if (mine.has(f.sha256)) return { file: mine.get(f.sha256)!, id: `${l.card.id}@${l.card.version}` };
    }
    return undefined;
  }

  review(key: string): ReviewStatus | undefined {
    return this.reviews.get(key);
  }

  /** Reviews a model, gathers the quorum, and lists it. `signer` must be the card's creator. */
  async publish(req: PublishRequest, signer: string, step: (s: Omit<ReviewStep, "at">) => void = () => {}): Promise<ListingRecord & { passport: ModelPassport }> {
    const { svc } = this.opts;
    const card = req.card as ModelCard;
    if (signer.toLowerCase() !== card?.creator?.address) throw new ModelRejected(["only the card's creator can publish it"]);
    let review: Review;
    try {
      review = await reviewModel(req, { ...this.opts.review, ...(svc.zgStorage ? { zg: svc.zgStorage } : {}) });
    } catch (err) {
      step({ step: "lead", ok: false, by: svc.address, detail: ((err as { reasons?: string[] }).reasons ?? [(err as Error).message])[0] });
      throw err;
    }
    const { benchmark } = review;
    step({
      step: "lead",
      ok: true,
      by: svc.address,
      detail: `${review.weights.checked ? `malware checks passed on ${review.weights.files.length} files; ` : ""}benchmark ${benchmark.correct}/${benchmark.items}`,
    });
    if (this.listings.has(review.key)) throw new ModelRejected([`${card.id}@${card.version} is already listed: a version can't change, publish a new one`]);
    const taken = this.weightsOwner(card);
    if (taken) throw new ModelRejected([`${taken.file} is already listed as ${taken.id} by another creator`]);

    const body = draftPassport(req, review, svc);
    const info = await svc.vault.info();
    const reasons: string[] = [];
    const votes = await Promise.all(
      this.opts.reviewers.map((r) =>
        r.attestModel(req, body).then(
          (vote) => (step({ step: "cosigner", ok: true, by: vote.address.toLowerCase(), detail: "re-ran the review and signed" }), vote),
          (err: Error & { reasons?: string[] }) => {
            reasons.push(...(err.reasons ?? [err.message]).slice(0, 2));
            step({ step: "cosigner", ok: false, detail: (err.reasons ?? [err.message])[0] });
            return undefined;
          },
        ),
      ),
    );
    const passport: ModelPassport = { ...body, attestations: { verifiers: [await signModelPassport(svc.account, body), ...votes.filter((v): v is { address: string; signature: string } => !!v)] } };
    const signers = await modelPassportSigners(passport, info.verifiers);
    if (signers.length < info.threshold) {
      throw new ModelRejected([`only ${signers.length} of the ${info.threshold} verifiers needed signed the passport`, ...reasons]);
    }
    passport.attestations.verifiers = passport.attestations.verifiers.filter((a) => signers.includes(a.address.toLowerCase()));

    const passportBytes = new TextEncoder().encode(JSON.stringify(passport, null, 2));
    const passportRef = await svc.storage.upload(passportBytes);
    const passportDigest = modelPassportDigest(passport);
    step({ step: "passport", ok: true, detail: `signed by ${signers.length} verifiers`, ref: passportRef });
    const payload: ListingPayload = {
      card,
      passportRef,
      passportDigest,
      accuracy: review.benchmark.accuracy,
      ...(review.weights.checked ? { params: review.weights.params } : {}),
      weightsChecked: review.weights.checked,
      signers,
    };
    const receipt = await this.opts.receipts.submit({
      t: "model",
      model: review.key,
      id: card.id,
      version: card.version,
      creator: card.creator.address,
      royaltyBps: card.royaltyBps,
      digest: passportDigest,
      ref: passportRef,
      accuracy: Math.round(review.benchmark.accuracy * 1000) / 1000,
      signers,
    });
    step({ step: "hcs", ok: true, ref: String(receipt.sequence) });
    const entityKey = await svc.arkiv.create({ kind: "model", ttlSeconds: TTL.model, attrs: listingAttrs(review.key, payload), payload });
    step({ step: "arkiv", ok: true, ref: entityKey });
    const record: ListingRecord = { ...payload, key: review.key, entityKey, ...(review.fingerprint ? { fingerprint: review.fingerprint } : {}), issuedAt: Date.now(), renewedAt: Date.now(), arkivChainId: svc.cfg.arkiv.chainId };
    this.listings.set(review.key, record);
    this.save();
    this.log(`listed ${card.id}@${card.version}`, { key: review.key, accuracy: review.benchmark.accuracy, signers: signers.length, passport: passportRef });
    return { ...record, passport };
  }

  /**
   * Extends every listing due for renewal, and re-creates any that expired. A listing written to
   * another Arkiv network (the verifier moved, say from Tiramisu to Rabdi) is re-created on this
   * one straight away: its passport on 0G Storage and receipt on HCS don't depend on Arkiv.
   */
  renew(now = Date.now()): Promise<void> {
    // One renewal at a time; a caller during one waits for it.
    this.renewal ??= this.renewOnce(now).finally(() => (this.renewal = undefined));
    return this.renewal;
  }

  private async renewOnce(now: number): Promise<void> {
    {
      const { arkiv, cfg } = this.opts.svc;
      const recreate = async (r: ListingRecord, why: string) => {
        const { key: _k, entityKey: _e, fingerprint: _f, issuedAt: _i, renewedAt: _r, arkivChainId: _c, ...payload } = r;
        r.entityKey = await arkiv.create({ kind: "model", ttlSeconds: TTL.model, attrs: listingAttrs(r.key, payload), payload });
        r.arkivChainId = cfg.arkiv.chainId;
        this.log(`listing for ${r.card.id}@${r.card.version} ${why}; re-created on Arkiv`);
      };
      for (const r of this.listings.values()) {
        if ((r.arkivChainId ?? LEGACY_ARKIV_CHAIN_ID) !== cfg.arkiv.chainId) {
          try {
            await recreate(r, `was on Arkiv chain ${r.arkivChainId ?? LEGACY_ARKIV_CHAIN_ID}`);
            r.renewedAt = now;
          } catch (err) {
            this.log("listing move failed", { key: r.key, error: (err as Error).message });
          }
          continue;
        }
        if (now - r.renewedAt < RENEW_EVERY_MS) continue;
        try {
          await arkiv.extend(r.entityKey, TTL.model);
        } catch (err) {
          if (!/expired|not ?found|no ?entity|does not exist/i.test((err as Error).message)) {
            this.log("listing renewal failed", { key: r.key, error: (err as Error).message });
            continue;
          }
          await recreate(r, "had expired");
        }
        r.renewedAt = now;
      }
      this.save();
    }
  }
}

/** The passport body every verifier signs, built from the lead's review. */
export function draftPassport(req: PublishRequest, review: Review, svc: Pick<Services, "cfg" | "storage">): ModelPassportBody {
  const { card } = req;
  return {
    kind: MODEL_PASSPORT_KIND,
    key: review.key,
    network: svc.cfg.network,
    issuedAt: new Date().toISOString(),
    card,
    cardDigest: cardDigest(card),
    creatorSignature: req.signature,
    weights: review.weights,
    benchmark: review.benchmark,
    ...(review.fingerprint ? { fingerprint: review.fingerprint } : {}),
    references: { hcsTopic: svc.cfg.hedera.hcsTopicId, storageGateway: svc.storage.gateway, ...(svc.cfg.network === "testnet" && svc.cfg.hedera.vaultAddress ? { vault: svc.cfg.hedera.vaultAddress } : {}) },
    limitations: modelPassportLimitations(card, review.weights, review.benchmark, review.fingerprint),
  };
}
