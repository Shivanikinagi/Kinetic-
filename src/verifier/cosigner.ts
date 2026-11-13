import type { Server } from "node:http";
import type { Hex, LocalAccount } from "viem";
import type { NetworkConfig } from "../config.js";
import { verifyReveal } from "../core/canary.js";
import { quorumSignatures, resolutionDigest, signDigest, verdictDigest, type SlashVerdict } from "../core/verdict.js";
import { attrStr, type ArkivStore } from "../integrations/arkiv.js";
import { readJobReceipts } from "../integrations/hcs.js";
import { creditedAmount } from "../integrations/mirror.js";
import type { BondVault } from "../integrations/vault.js";
import type { ZeroGClient } from "../integrations/zerog.js";
import { agreement } from "../tasks/compare.js";
import { validateResult } from "../tasks/validate.js";
import type { Item } from "../types.js";
import { canonicalJson, decryptJson, deriveKey, fromBase64, sha256Hex } from "../util/crypto.js";
import { createApp, listen, rawBody, route } from "../util/http.js";
import { logger } from "../util/log.js";
import { recoverResultSigner, signedPost, verifySignedRequest, executionHash } from "../util/sign.js";
import { checkExecutionRecord, evidenceOf, type FailureEvidence, type SlashPacket } from "./checks.js";
import { goldFor, loadGold, truthOf, verifyKnownReveal, type GoldSet } from "./known.js";
import { cardDigest } from "../models/card.js";
import { modelPassportLimitations, signModelPassport, type ModelPassportBody } from "../models/passport.js";
import { compareReviews, loadProbeItems, ModelRejected, reviewModel, type PublishRequest, type Review as ModelReview } from "../models/review.js";
import { defaultModelRunner, type ModelRunner } from "../models/runner.js";
import type { ModelReviewer } from "./models.js";
import type { ZgStorage } from "../integrations/zg-storage.js";
import { itemCorrect } from "../tasks/compare.js";

// A cosigner is one of the vault's other verifiers. It never takes the lead verifier's word:
// before signing a slash it re-checks the evidence itself. It confirms the canary set against
// the commitment on HCS, looks up every missed known answer in its own copy of the labelled
// set, re-runs every failed model canary on 0G with its own credits, re-validates
// malformed results and 0G execution records, checks each result was signed by the provider,
// and caps the refund at what the mirror node shows the provider was paid. It signs only when
// at least the slash limit of failures holds up. For a disputed slash it re-checks the same way
// and signs whichever way the evidence points.

export interface CosignerDeps {
  cfg: NetworkConfig;
  account: LocalAccount;
  zerog: ZeroGClient;
  arkiv: ArkivStore;
  vault: BondVault;
  /** This verifier's own copy of the labelled items planted as known answers, per task. */
  gold?: GoldSet[];
  /** How this verifier runs a model it reviews for a Model Passport (default: 0G, or VERIFIER_MODEL_URL). */
  runner?: ModelRunner;
  /** 0G Storage, to fetch weights a card keeps there. */
  zgStorage?: () => ZgStorage;
}

export interface Review {
  ok: boolean;
  /** Failures this verifier confirmed on its own. */
  confirmed: number;
  reasons: string[];
}

export class CosignRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(`won't co-sign: ${reasons.slice(0, 3).join("; ")}`);
  }
}

/** Signs slash verdicts and dispute decisions after checking them. */
export interface SlashReviewer {
  cosign(packet: SlashPacket): Promise<{ signature: Hex; signer: string }>;
  reviewDispute(packet: SlashPacket, slashId: Hex): Promise<{ upheld: boolean; signature: Hex; signer: string }>;
}

export const verdictFromPacket = (p: SlashPacket): SlashVerdict => ({ ...p.verdict, refundTinybar: BigInt(p.verdict.refundTinybar) });

export class Cosigner implements SlashReviewer, ModelReviewer {
  private readonly log = logger("cosigner");

  constructor(private readonly deps: CosignerDeps) {}

  get address(): string {
    return this.deps.account.address.toLowerCase();
  }

  async review(packet: SlashPacket): Promise<Review> {
    const { cfg } = this.deps;
    const v = packet.verdict;
    const reg = packet.registration;
    const provider = v.provider.toLowerCase();
    const refuse = (reason: string): Review => ({ ok: false, confirmed: 0, reasons: [reason] });

    if (v.jobId !== reg.jobId || v.buyer.toLowerCase() !== reg.buyer.toLowerCase()) return refuse("the verdict names a different job or buyer");
    // The evidence the vault will hash must list exactly the failures in this packet.
    let listed: { k: string; i: number; r: string }[];
    try {
      listed = (JSON.parse(v.evidence) as { failures: typeof listed; provider: string; job: string }).failures;
    } catch {
      return refuse("evidence is not JSON");
    }
    const ev = JSON.parse(v.evidence) as { topic: string; receipts: number[]; provider: string; job: string };
    if (ev.provider !== provider || ev.job !== reg.jobId || v.evidence !== evidenceOf(ev.topic, reg.jobId, provider, ev.receipts, packet.failures)) {
      return refuse("evidence does not match the failures sent");
    }
    if (!listed.some((f) => f.i === v.chunk && f.r === v.resultHash)) return refuse("the verdict's chunk and result are not among the failures");

    // The canary set was committed on HCS before any chunk ran.
    const receipts = await readJobReceipts(cfg.hedera.mirrorUrl, cfg.hedera.hcsTopicId, reg.jobId).catch(() => []);
    const job = receipts.map((m) => m.receipt).find((r) => r.t === "job");
    if (!job || job.t !== "job") return refuse("no job receipt on HCS");
    if (job.buyer.toLowerCase() !== reg.buyer.toLowerCase() || job.chunks !== reg.chunks.length) return refuse("the job differs from the one on HCS");
    if (!verifyReveal(reg.jobId, packet.canaries.indices, packet.canaries.salt, job.commitment)) return refuse("the canary set differs from the commitment on HCS");
    if (packet.known && (!job.known || !verifyKnownReveal(reg.jobId, packet.known.placements, packet.known.salt, job.known))) return refuse("the known-answer placements differ from the commitment on HCS");

    // The refund can't exceed what the provider was actually paid in this job.
    if (!(await this.payToBelongs(packet.payTo, provider))) return refuse(`payment account ${packet.payTo} does not belong to ${provider}`);
    let paid = 0n;
    for (const tx of new Set(packet.payments)) paid += await creditedAmount(cfg.hedera.mirrorUrl, tx, packet.payTo);
    if (BigInt(v.refundTinybar) > paid) return refuse(`refund ${v.refundTinybar} exceeds the ${paid} paid to the provider`);

    const [offer] = await this.deps.arkiv.query("offer", { provider }, { owner: provider, creator: provider, limit: 1, orderBy: { attr: "$expiresAt", desc: true } }).catch(() => []);
    const declared = offer ? attrStr(offer, "zg_provider").toLowerCase() || undefined : undefined;
    const reasons: string[] = [];
    let confirmed = 0;
    const seen = new Set<string>();
    for (const f of packet.failures) {
      const key = `${f.kind}|${f.idx}|${f.response.resultHash}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const why = await this.unconfirmed(packet, f, provider, declared);
      if (why) reasons.push(`#${f.idx} ${f.kind}: ${why}`);
      else confirmed += 1;
    }
    const { failLimit } = cfg.policy;
    if (confirmed < failLimit) return { ok: false, confirmed, reasons: [`confirmed ${confirmed} of ${packet.failures.length} failures; the slash limit is ${failLimit}`, ...reasons] };
    return { ok: true, confirmed, reasons };
  }

  /** Why a failure doesn't hold up, or undefined when it does. */
  private async unconfirmed(packet: SlashPacket, f: FailureEvidence, provider: string, declared?: string): Promise<string | undefined> {
    const { cfg } = this.deps;
    const reg = packet.registration;
    const r = f.response;
    const chunk = reg.chunks.find((c) => c.idx === f.idx);
    if (!chunk || r.jobId !== reg.jobId || r.idx !== f.idx) return "not a chunk of this job";
    if (sha256Hex(canonicalJson(r.result)) !== r.resultHash) return "result hash mismatch";
    const signer = await recoverResultSigner(r.jobId, r.idx, r.resultHash, r.signature as Hex, executionHash(r.execution), r.model).catch(() => "");
    if (signer !== provider) return "result not signed by the provider";

    if (f.kind === "format") {
      if (!chunk.itemIds) return "no item ids to check the format against";
      return validateResult(reg.task, chunk.itemIds.map((id) => ({ id, text: "" })), r.result).length > 0 ? undefined : "the result is well-formed";
    }
    if (f.kind === "execution") {
      const { problem } = await checkExecutionRecord(cfg, reg.task, chunk.itemIds, declared, r);
      return problem ? undefined : "the 0G execution record checks out";
    }
    if (f.kind === "known") {
      // The answer comes from this verifier's own labelled set, found by the planted item's text.
      const ids = packet.known?.placements.find((p) => p.idx === f.idx)?.ids ?? [];
      if (ids.length === 0) return "no known answer was committed for this chunk";
      const set = goldFor(this.deps.gold ?? [], reg.task);
      if (!set) return "this verifier has no labelled set for this task";
      let items: Item[];
      try {
        items = decryptJson<Item[]>(deriveKey(fromBase64(reg.jobKey), `chunk:${f.idx}`), fromBase64(chunk.data));
      } catch (err) {
        return `could not open the chunk: ${(err as Error).message}`;
      }
      for (const id of ids) {
        const text = items.find((i) => i.id === id)?.text;
        const gold = set.items.find((g) => g.text === text);
        if (!gold) return `planted item ${id} is not in this verifier's labelled set`;
        if (!itemCorrect(reg.task, truthOf(reg.task, gold, id), r.result.items.find((i) => i.id === id))) return undefined;
      }
      return "every planted item was answered correctly";
    }
    // A model canary only counts toward slashing when the policy says so.
    if (!cfg.policy.modelSlashes) return "disagreeing with the reference model doesn't count toward slashing";
    // Canary: this verifier's own 0G run on the chunk, scored by the protocol's bar.
    if (!packet.canaries.indices.includes(f.idx)) return "not a committed canary";
    try {
      const items = decryptJson<Item[]>(deriveKey(fromBase64(reg.jobKey), `chunk:${f.idx}`), fromBase64(chunk.data));
      const ref = await this.deps.zerog.reference(reg.task, items);
      const score = agreement(reg.task, ref.result, r.result);
      return score < cfg.policy.minAgreement ? undefined : `agrees ${Math.round(score * 100)}% with this verifier's own 0G run (${ref.requestId})`;
    } catch (err) {
      return `could not re-run it on 0G: ${(err as Error).message}`;
    }
  }

  /** On testnet a payTo is a Hedera account; the mirror node says which EVM address it is. */
  private async payToBelongs(payTo: string, provider: string): Promise<boolean> {
    if (this.deps.cfg.network === "devnet") return payTo.toLowerCase() === provider;
    const res = await fetch(`${this.deps.cfg.hedera.mirrorUrl}/api/v1/accounts/${payTo}`).catch(() => undefined);
    if (!res?.ok) return false;
    const body = (await res.json()) as { evm_address?: string };
    return (body.evm_address ?? "").toLowerCase() === provider;
  }

  async cosign(packet: SlashPacket): Promise<{ signature: Hex; signer: string }> {
    const review = await this.review(packet);
    const verdict = verdictFromPacket(packet);
    this.log(`${review.ok ? "CO-SIGNED" : "REFUSED"} slash of ${verdict.provider} in ${verdict.jobId}`, { confirmed: review.confirmed, reasons: review.reasons.slice(0, 3) });
    if (!review.ok) throw new CosignRefused(review.reasons);
    const info = await this.deps.vault.info();
    return { signature: await signDigest(this.deps.account, verdictDigest(verdict, info)), signer: this.address };
  }

  async reviewDispute(packet: SlashPacket, slashId: Hex): Promise<{ upheld: boolean; signature: Hex; signer: string }> {
    const review = await this.review(packet);
    const info = await this.deps.vault.info();
    this.log(`dispute of ${packet.verdict.provider}: ${review.ok ? "UPHOLD" : "OVERTURN"}`, { confirmed: review.confirmed, reasons: review.reasons.slice(0, 3) });
    return { upheld: review.ok, signature: await signDigest(this.deps.account, resolutionDigest(slashId, review.ok, info)), signer: this.address };
  }

  /**
   * Re-reviews a model on its own (its own downloads, model runs and labelled set) and signs
   * the lead's Model Passport only if it reaches the same answers.
   */
  async attestModel(req: PublishRequest, body: ModelPassportBody): Promise<{ address: string; signature: string }> {
    const { cfg } = this.deps;
    const probeTask = loadGold()?.task;
    let mine: ModelReview;
    try {
      mine = await reviewModel(req, {
        ...(this.deps.zgStorage ? { zg: this.deps.zgStorage } : {}),
        runner: this.deps.runner ?? defaultModelRunner(this.deps.zerog),
        gold: this.deps.gold ?? [],
        probes: probeTask ? { task: probeTask, items: loadProbeItems() } : null,
        minAccuracy: cfg.models.minAccuracy,
        benchmarkItems: cfg.models.benchmarkItems,
        maxDownloadBytes: cfg.models.maxDownloadBytes,
      });
    } catch (err) {
      if (err instanceof ModelRejected) throw new CosignRefused(err.reasons);
      throw err;
    }
    const reasons = compareReviews({ key: body.key, weights: body.weights, benchmark: body.benchmark, ...(body.fingerprint ? { fingerprint: body.fingerprint } : {}) }, mine);
    if (body.cardDigest !== cardDigest(req.card) || canonicalJson(body.card) !== canonicalJson(req.card) || body.creatorSignature !== req.signature) reasons.push("the passport's card isn't the card that was sent");
    if (canonicalJson(body.limitations) !== canonicalJson(modelPassportLimitations(body.card, body.weights, body.benchmark, body.fingerprint))) reasons.push("the passport's limitations were changed");
    if (body.benchmark.minAccuracy < cfg.models.minAccuracy) reasons.push("the listing bar is below this verifier's");
    this.log(`model ${req.card.id}@${req.card.version}: ${reasons.length ? "REFUSE" : "SIGN"}`, { reasons: reasons.slice(0, 3) });
    if (reasons.length > 0) throw new CosignRefused(reasons);
    return signModelPassport(this.deps.account, body);
  }
}

/** A cosigner on another machine, reached over HTTP with signed requests. */
export class CosignerClient implements SlashReviewer, ModelReviewer {
  constructor(
    readonly url: string,
    private readonly account: LocalAccount,
  ) {}

  private async call<T>(path: string, body: unknown): Promise<T> {
    const res = await signedPost(this.account, `${this.url}${path}`, body);
    if (!res.ok) {
      const text = await res.text();
      let reasons: string[] | undefined;
      try {
        reasons = (JSON.parse(text) as { reasons?: string[] }).reasons;
      } catch {
        // Not JSON.
      }
      if (res.status === 409 && reasons) throw new CosignRefused(reasons);
      throw new Error(`cosigner ${this.url}${path} failed (${res.status}): ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  cosign(packet: SlashPacket) {
    return this.call<{ signature: Hex; signer: string }>("/cosign", { packet });
  }

  reviewDispute(packet: SlashPacket, slashId: Hex) {
    return this.call<{ upheld: boolean; signature: Hex; signer: string }>("/review", { packet, slashId });
  }

  /** Asks for a model review and polls until it's done: a review takes minutes (see startCosigner). */
  async attestModel(req: PublishRequest, body: ModelPassportBody): Promise<{ address: string; signature: string }> {
    const deadline = Date.now() + ATTEST_TIMEOUT_MS;
    for (;;) {
      const r = await this.call<{ address: string; signature: string } | { pending: true }>("/models/attest", { req, body });
      if (!("pending" in r)) return r;
      if (Date.now() > deadline) throw new Error(`cosigner ${this.url} didn't finish its review in ${ATTEST_TIMEOUT_MS / 60_000} minutes`);
      await new Promise((resolve) => setTimeout(resolve, ATTEST_POLL_MS));
    }
  }
}

/** How long a lead verifier waits for a cosigner's model review, and how often it asks. */
const ATTEST_TIMEOUT_MS = 3 * 60 * 60_000;
const ATTEST_POLL_MS = 5000;
/** How long a cosigner answers a request before saying "pending", and keeps a finished review. */
const ATTEST_ANSWER_MS = 20_000;
const ATTEST_KEEP_MS = 60 * 60_000;

/** Collects verifier signatures sorted for the vault, keeping only those from its verifier set. */
export async function collectQuorum(digest: Hex, signatures: (Hex | undefined)[], verifiers: string[]) {
  return quorumSignatures(digest, signatures.filter((s): s is Hex => s !== undefined), verifiers);
}

/**
 * HTTP front for a cosigner: `npm run cosigner`. Only the vault's own verifiers may ask it to
 * review, since every review spends its 0G credits.
 */
export async function startCosigner(deps: CosignerDeps, port: number): Promise<{ cosigner: Cosigner; url: string; close: () => Promise<void> }> {
  const cosigner = new Cosigner(deps);
  const app = createApp();
  const fromVerifier = async (req: Parameters<Parameters<typeof route>[0]>[0]) => {
    const signer = await verifySignedRequest(req.headers, rawBody(req));
    if (!(await deps.vault.info()).verifiers.includes(signer)) throw Object.assign(new Error("only the vault's verifiers may ask for a review"), { status: 403 });
  };
  const fail = (res: Parameters<Parameters<typeof route>[0]>[1], err: unknown) => {
    if (err instanceof CosignRefused) return void res.status(409).json({ error: err.message, reasons: err.reasons });
    const status = (err as { status?: number }).status ?? (/signature/.test((err as Error).message) ? 401 : 500);
    res.status(status).json({ error: (err as Error).message });
  };
  const handle = (fn: (body: { packet: SlashPacket; slashId?: Hex; req: PublishRequest; body: ModelPassportBody }) => Promise<unknown>) =>
    route(async (req, res) => {
      try {
        await fromVerifier(req);
        res.json(await fn(req.body));
      } catch (err) {
        fail(res, err);
      }
    });
  // A model review downloads the weights and benchmarks the model: minutes on a real network,
  // longer than an HTTP client waits for a response. The first request starts it; the same request
  // sent again answers 202 "pending" until it's done, then with its result.
  // `finishedAt`: a finished review is kept for ATTEST_KEEP_MS after it finishes (not after it
  // started: a review of multi-GB weights can itself take longer than that).
  type Attest = { finishedAt?: number; run: Promise<void>; done?: { ok: unknown } | { err: unknown } };
  const attests = new Map<string, Attest>();
  app.post(
    "/models/attest",
    route(async (req, res) => {
      try {
        await fromVerifier(req);
        for (const [id, a] of attests) if (a.finishedAt !== undefined && Date.now() - a.finishedAt > ATTEST_KEEP_MS) attests.delete(id);
        const id = sha256Hex(rawBody(req));
        let a: Attest | undefined = attests.get(id);
        if (!a) {
          const entry: Attest = { run: Promise.resolve() };
          entry.run = cosigner.attestModel(req.body.req, req.body.body).then(
            (ok) => void ((entry.done = { ok }), (entry.finishedAt = Date.now())),
            (err: unknown) => void ((entry.done = { err }), (entry.finishedAt = Date.now())),
          );
          attests.set(id, (a = entry));
        }
        await Promise.race([a.run, new Promise((r) => setTimeout(r, ATTEST_ANSWER_MS))]);
        if (!a.done) return void res.status(202).json({ pending: true });
        if ("ok" in a.done) return void res.json(a.done.ok);
        fail(res, a.done.err);
      } catch (err) {
        fail(res, err);
      }
    }),
  );
  app.get("/status", route(async (_req, res) => void res.json({ cosigner: cosigner.address, network: deps.cfg.network, policy: deps.cfg.policy })));
  app.post("/cosign", handle((b) => cosigner.cosign(b.packet)));
  app.post("/review", handle((b) => cosigner.reviewDispute(b.packet, b.slashId as Hex)));
  const server: Server = await listen(app, port);
  return {
    cosigner,
    url: `http://localhost:${port}`,
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}
