import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  HTTPFacilitatorClient,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { createClientHederaSigner, PrivateKey, Transaction } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import type { Request, Response } from "express";
import type { LocalAccount } from "viem";
import type { Identity } from "../config.js";
import { canonicalJson, sha256Hex } from "../util/crypto.js";
import { writeJsonAtomic } from "../util/state.js";

// x402 per chunk. Every chunk request is its own HTTP 402 exchange: the provider quotes,
// the buyer agent signs a payment, the provider asks the facilitator to verify it, does the
// work, and only settles once the work succeeded. A chunk that errors is never charged.

const X402_VERSION = 2;

export interface GateOptions {
  network: string;
  /** The facilitator, when there is one. With `facilitatorUrls`, it is ignored. */
  facilitatorUrl: string;
  /** Facilitators in order of preference: quotes fail over to the next healthy one. */
  facilitatorUrls?: string[];
  asset: string;
  payTo: string;
  /** Default price; `handle` can quote a different amount per request. */
  amount: bigint;
  description: string;
  maxTimeoutSeconds?: number;
  onSettled?: (settlement: SettleResponse, amount: bigint) => void;
  /** Shared by gates that take the same payments (the verifier's per-job fee gates). */
  replay?: ReplayGuard;
}

/** Long past the 180 s a Hedera transaction or a devnet authorization stays valid. */
const REPLAY_TTL_MS = 10 * 60_000;

/**
 * Payment headers a gate already accepted. Each is kept until the payment it carries could no
 * longer be valid anyway, so the set stays small. With a file it survives a restart, so a
 * settled header can't make a restarted node do the work again.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(private readonly file?: string) {
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
      for (const [key, until] of Object.entries(saved)) if (until > Date.now()) this.seen.set(key, until);
    } catch {
      // No file yet.
    }
  }

  /** Marks a header as used. False when it already was. */
  claim(key: string): boolean {
    const now = Date.now();
    for (const [k, until] of this.seen) if (until <= now) this.seen.delete(k);
    if (this.seen.has(key)) return false;
    this.seen.set(key, now + REPLAY_TTL_MS);
    this.save();
    return true;
  }

  /** Frees a header whose payment was not settled, so the payer may retry it. */
  release(key: string): void {
    if (this.seen.delete(key)) this.save();
  }

  private save() {
    if (this.file) writeJsonAtomic(this.file, Object.fromEntries(this.seen));
  }
}

/** A facilitator gave no answer (5xx, timeout, dropped connection), as opposed to a refusal. */
const NO_ANSWER = /\b5\d\d\b|timeout|timed out|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up|aborted/i;

interface Facilitator {
  url: string;
  client: HTTPFacilitatorClient;
  /** Its `exact` extras for the network (Hedera: the feePayer), once /supported answered. */
  extra?: Record<string, unknown>;
  /** Not asked for quotes before this time (ms). */
  downUntil: number;
  /** Consecutive verify/settle calls it gave no answer to. */
  failures: number;
  /** When /supported was last asked (ms). */
  probedAt?: number;
}

/**
 * The facilitators a node can quote, in order of preference, shared by all its gates. A quote
 * comes from the first healthy one that supports `exact` on the network (checked via
 * /supported); one that stops answering is skipped for a while and quotes move to the next. A
 * Hedera payment is a transaction signed for the quoting facilitator's fee payer, so it is
 * verified and settled by that same facilitator, found again from the payment's `extra`.
 */
export class FacilitatorPool {
  private readonly list: Facilitator[];

  constructor(
    urls: string[],
    private readonly network: string,
    private readonly opts = { cooldownMs: 60_000, failuresToRotate: 2, probeTimeoutMs: 10_000 },
  ) {
    if (urls.length === 0) throw new Error("no x402 facilitator configured");
    this.list = urls.map((url) => ({ url, client: new HTTPFacilitatorClient({ url }), downUntil: 0, failures: 0 }));
  }

  get urls(): string[] {
    return this.list.map((f) => f.url);
  }

  /** Asks /supported for the network's `exact` extras. Throws when it can't, or doesn't support it. */
  private async probe(f: Facilitator): Promise<Record<string, unknown>> {
    f.probedAt = Date.now();
    const probe = new HTTPFacilitatorClient({ url: f.url, timeoutMs: this.opts.probeTimeoutMs });
    const supported = await probe.getSupported();
    const kind = supported.kinds.find((k) => k.scheme === "exact" && k.network === this.network);
    if (!kind) throw new Error(`facilitator ${f.url} does not support exact on ${this.network}`);
    f.extra = { ...(kind.extra ?? {}) };
    return f.extra;
  }

  /** The facilitator new quotes go to, and its extras. Healthy ones first, in order. */
  async pick(): Promise<{ url: string; extra: Record<string, unknown> }> {
    const now = Date.now();
    const order = [...this.list.filter((f) => f.downUntil <= now), ...this.list.filter((f) => f.downUntil > now)];
    const errors: string[] = [];
    for (const f of order) {
      if (f.extra && f.downUntil <= now) return { url: f.url, extra: f.extra };
      try {
        const extra = await this.probe(f);
        f.downUntil = 0;
        f.failures = 0;
        return { url: f.url, extra };
      } catch (err) {
        f.downUntil = Date.now() + this.opts.cooldownMs;
        errors.push(`${f.url}: ${(err as Error).message.slice(0, 120)}`);
      }
    }
    throw new Error(`no x402 facilitator available (${errors.join("; ")})`);
  }

  /** The facilitator that quoted a payment, by the extras it was signed against. */
  async issuerOf(extra: Record<string, unknown> | undefined): Promise<Facilitator | undefined> {
    const key = canonicalJson(extra ?? {});
    const known = this.list.find((f) => f.extra && canonicalJson(f.extra) === key);
    if (known) return known;
    // Quoted before a restart, by one not asked since: ask the rest (each at most once per cooldown).
    const stale = this.list.filter((f) => !f.extra && Date.now() - (f.probedAt ?? 0) > this.opts.cooldownMs);
    await Promise.all(stale.map((f) => this.probe(f).catch(() => undefined)));
    return this.list.find((f) => f.extra && canonicalJson(f.extra) === key);
  }

  /** Records a call it gave no answer to; enough in a row and new quotes go elsewhere. */
  failed(f: Facilitator): void {
    f.failures += 1;
    if (f.failures >= this.opts.failuresToRotate) {
      f.downUntil = Date.now() + this.opts.cooldownMs;
      f.failures = 0;
    }
  }

  answered(f: Facilitator): void {
    f.failures = 0;
  }
}

const pools = new Map<string, FacilitatorPool>();

/** One pool per network and facilitator list, so every gate of a node shares its health record. */
export function facilitatorPool(urls: string[], network: string): FacilitatorPool {
  const key = `${network}|${urls.join(",")}`;
  let pool = pools.get(key);
  if (!pool) pools.set(key, (pool = new FacilitatorPool(urls, network)));
  return pool;
}

export class PaymentGate {
  private readonly facilitators: FacilitatorPool;
  private readonly replay: ReplayGuard;

  constructor(private readonly opts: GateOptions) {
    const hedera = opts.network.startsWith("hedera:");
    // Hedera facilitators take a payee account id, and a payment window of at most 180 s.
    if (hedera && !/^\d+\.\d+\.\d+$/.test(opts.payTo)) throw new Error(`payTo must be a Hedera account id (0.0.x) on ${opts.network}, got ${opts.payTo}`);
    if (hedera && (opts.maxTimeoutSeconds ?? 180) > 180) throw new Error("maxTimeoutSeconds must be at most 180 on Hedera");
    this.facilitators = facilitatorPool(opts.facilitatorUrls?.length ? opts.facilitatorUrls : [opts.facilitatorUrl], opts.network);
    this.replay = opts.replay ?? new ReplayGuard();
  }

  private requirementsWith(amount: bigint, extra: Record<string, unknown>): PaymentRequirements {
    return {
      scheme: "exact",
      network: this.opts.network as PaymentRequirements["network"],
      asset: this.opts.asset,
      amount: amount.toString(),
      payTo: this.opts.payTo,
      maxTimeoutSeconds: this.opts.maxTimeoutSeconds ?? 180,
      extra,
    };
  }

  /** Payment requirements from the first healthy facilitator, including its extras such as Hedera's feePayer. */
  async getRequirements(amount = this.opts.amount): Promise<PaymentRequirements> {
    return this.requirementsWith(amount, (await this.facilitators.pick()).extra);
  }

  async handle(req: Request, res: Response, work: () => Promise<object>, amount = this.opts.amount): Promise<void> {
    const resource = { url: `${req.protocol}://${req.get("host")}${req.originalUrl}`, description: this.opts.description, mimeType: "application/json" };
    const deny = async (error: string) => {
      let quote: PaymentRequirements;
      try {
        quote = await this.getRequirements(amount);
      } catch (err) {
        return void res.status(503).json({ error: "no x402 facilitator available", message: (err as Error).message, denied: error });
      }
      const body: PaymentRequired = { x402Version: X402_VERSION, error, resource, accepts: [quote] };
      res.status(402).set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(body)).json(body);
    };

    const header = req.get("payment-signature") ?? req.get("x-payment");
    if (!header) return deny("payment required");

    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(header);
    } catch {
      return deny("malformed payment header");
    }
    const a = payload.accepted;
    // Verified and settled by the facilitator that quoted it: the payment is signed for its fee payer.
    const facilitator = a ? await this.facilitators.issuerOf(a.extra) : undefined;
    const requirements = this.requirementsWith(amount, facilitator?.extra ?? {});
    if (!a || !facilitator || a.scheme !== requirements.scheme || a.network !== requirements.network || a.asset !== requirements.asset || a.amount !== requirements.amount || a.payTo !== requirements.payTo) {
      return deny("payment does not match the quoted requirements");
    }

    const replayKey = sha256Hex(header);
    if (!this.replay.claim(replayKey)) return deny("payment already used");

    // Verify only checks the payment, so no answer (a 520, say) is asked again, like settle below.
    for (let attempt = 1; ; attempt++) {
      try {
        const verified = await facilitator.client.verify(payload, requirements);
        this.facilitators.answered(facilitator);
        if (!verified.isValid) {
          this.replay.release(replayKey);
          return deny(verified.invalidReason ?? "payment invalid");
        }
        break;
      } catch (err) {
        const noAnswer = NO_ANSWER.test((err as Error).message);
        if (noAnswer) this.facilitators.failed(facilitator);
        if (attempt >= SETTLE_ATTEMPTS || !noAnswer) {
          this.replay.release(replayKey);
          return deny(`verify failed: ${(err as Error).message.slice(0, 160)}`);
        }
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }

    let result: object;
    try {
      result = await work();
    } catch (err) {
      // Not settled, so the buyer is not charged and may retry or reroute. An error with a
      // `code` (e.g. "upstream_failed": the provider's own upstream failed) is passed on as 502.
      this.replay.release(replayKey);
      // An error with a `status` (a request the work refused, e.g. a model that fails review) keeps it, and its reasons.
      const e = err as Error & { code?: string; zgProvider?: string; status?: number; reasons?: string[] };
      res.status(e.status ?? (e.code ? 502 : 500)).json({ error: e.code ?? (e.status ? e.message : "chunk_failed"), message: e.message, ...(e.reasons ? { reasons: e.reasons } : {}), ...(e.zgProvider ? { zgProvider: e.zgProvider } : {}) });
      return;
    }

    // The public facilitator sometimes answers 5xx (a Cloudflare 520, say) or drops the
    // connection: that's no answer, so ask again. A payload is one pre-signed transaction with a
    // fixed id, so a retry can't pay twice. A refusal (success: false) is never retried. It can
    // only settle with the facilitator that quoted it; later quotes move on if this one is down.
    let settlement: SettleResponse | undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        settlement = await facilitator.client.settle(payload, requirements);
        this.facilitators.answered(facilitator);
        break;
      } catch (err) {
        const message = (err as Error).message;
        const noAnswer = NO_ANSWER.test(message);
        if (noAnswer) this.facilitators.failed(facilitator);
        if (attempt >= SETTLE_ATTEMPTS || !noAnswer) return deny(`settle failed: ${message.slice(0, 160)}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    if (!settlement.success) return deny(settlement.errorReason ?? "settlement failed");
    this.opts.onSettled?.(settlement, amount);
    res.set("PAYMENT-RESPONSE", encodePaymentResponseHeader(settlement)).json({ ...result, payment: settlement });
  }
}

/** Settlement attempts when the facilitator gives no answer (5xx, timeout, dropped connection). */
const SETTLE_ATTEMPTS = 3;

// ── Client side ──────────────────────────────────────────────────────────────

export interface PaymentSigner {
  readonly network: string;
  readonly payer: string;
  createPayload(requirements: PaymentRequirements): Promise<Record<string, unknown>>;
  /** Ledger id of the payment a payload will become once settled. */
  paymentId(payload: Record<string, unknown>): string;
  /** Whether that payment settled, for requests that died before their response arrived. */
  isSettled(paymentId: string): Promise<boolean>;
}

/** Hedera exact scheme: a partially signed TransferTransaction the facilitator completes and submits. */
export class HederaPaymentSigner implements PaymentSigner {
  readonly network = "hedera:testnet";
  readonly payer: string;
  private readonly scheme: ExactHederaScheme;

  constructor(
    identity: Identity,
    private readonly mirrorUrl: string,
  ) {
    if (!identity.hederaAccountId) throw new Error("HEDERA_ACCOUNT_ID is required to pay over x402 on Hedera");
    this.payer = identity.hederaAccountId;
    const key = PrivateKey.fromStringECDSA(identity.privateKey.slice(2));
    this.scheme = new ExactHederaScheme(createClientHederaSigner(identity.hederaAccountId, key, { network: this.network }));
  }

  async createPayload(requirements: PaymentRequirements) {
    const result = await this.scheme.createPaymentPayload(X402_VERSION, requirements);
    return result.payload;
  }

  paymentId(payload: Record<string, unknown>): string {
    return Transaction.fromBytes(Buffer.from(String(payload.transaction), "base64")).transactionId!.toString();
  }

  async isSettled(paymentId: string): Promise<boolean> {
    for (let i = 0; i < 8; i++) {
      const res = await fetch(`${this.mirrorUrl}/api/v1/transactions/${mirrorTransactionId(paymentId)}`);
      if (res.ok) {
        const body = (await res.json()) as { transactions?: { result: string }[] };
        if (body.transactions?.length) return body.transactions[0].result === "SUCCESS";
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return false;
  }
}

/** Devnet scheme: an EIP-191 signed transfer authorization, settled by the devnet facilitator. */
export class DevnetPaymentSigner implements PaymentSigner {
  readonly network = "kinetic:devnet";
  readonly payer: string;

  constructor(
    private readonly account: LocalAccount,
    private readonly devnetUrl: string,
  ) {
    this.payer = account.address.toLowerCase();
  }

  paymentId(payload: Record<string, unknown>): string {
    return String((payload.authorization as { nonce: string }).nonce);
  }

  async isSettled(paymentId: string): Promise<boolean> {
    const res = await fetch(`${this.devnetUrl}/facilitator/settled/${paymentId}`);
    return res.ok && ((await res.json()) as { settled: boolean }).settled;
  }

  async createPayload(requirements: PaymentRequirements) {
    const authorization = {
      from: this.payer,
      to: requirements.payTo,
      amount: requirements.amount,
      asset: requirements.asset,
      network: requirements.network,
      nonce: randomBytes(16).toString("hex"),
      validBefore: Math.floor(Date.now() / 1000) + requirements.maxTimeoutSeconds,
    };
    const signature = await this.account.signMessage({ message: canonicalJson(authorization) });
    return { authorization, signature };
  }
}

export class BudgetExceededError extends Error {}

/** A payment was sent but no response came back: it may or may not have settled. */
export class PaymentInFlightError extends Error {
  constructor(
    readonly paymentId: string,
    readonly amount: bigint,
    cause: unknown,
  ) {
    super(`payment ${paymentId} sent but the request failed: ${(cause as Error)?.message ?? cause}`);
  }
}

export interface PaidResponse {
  response: globalThis.Response;
  requirements?: PaymentRequirements;
  settlement?: SettleResponse;
}

/** fetch() that answers one HTTP 402 with a payment, refusing quotes above `maxAmount`. */
export async function payFetch(url: string, init: RequestInit, signer: PaymentSigner, maxAmount: bigint): Promise<PaidResponse> {
  const first = await fetch(url, init);
  if (first.status !== 402) return { response: first };

  const header = first.headers.get("payment-required");
  const required: PaymentRequired = header ? decodePaymentRequiredHeader(header) : await first.json();
  const requirements = required.accepts.find((r) => r.scheme === "exact" && r.network === signer.network);
  if (!requirements) throw new Error(`no ${signer.network} payment option offered by ${url}`);
  if (BigInt(requirements.amount) > maxAmount) {
    throw new BudgetExceededError(`quote ${requirements.amount} exceeds limit ${maxAmount}`);
  }

  const payment: PaymentPayload = {
    x402Version: required.x402Version,
    resource: required.resource,
    accepted: requirements,
    payload: await signer.createPayload(requirements),
  };
  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payment) },
    });
  } catch (err) {
    throw new PaymentInFlightError(signer.paymentId(payment.payload), BigInt(requirements.amount), err);
  }
  const settled = response.headers.get("payment-response");
  return { response, requirements, settlement: settled ? decodePaymentResponseHeader(settled) : undefined };
}

/** Converts a facilitator transaction id (0.0.x@s.n) to the mirror node form (0.0.x-s-n). */
export function mirrorTransactionId(tx: string): string {
  const at = tx.indexOf("@");
  return at < 0 ? tx : `${tx.slice(0, at)}-${tx.slice(at + 1).replace(".", "-")}`;
}
