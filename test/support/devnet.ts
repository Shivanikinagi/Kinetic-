import type { Services } from "../../src/integrations/index.js";
import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { recoverMessageAddress, type Hex } from "viem";
import { resolutionDigest, slashIdOf, verdictDigest, type SlashVerdict } from "../../src/core/verdict.js";
import { contentAddress, swarmChunks } from "../../src/integrations/swarm-bmt.js";
import { feedUpdateAddress, readSoc, readStamp, socAddress } from "../../src/integrations/swarm-feed.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { WireAttr } from "../../src/integrations/arkiv.js";
import { mirrorTransactionId } from "../../src/integrations/x402.js";
import { heuristicRun } from "./heuristic.js";
import { parseTaskBlock } from "../../src/tasks/prompt.js";
import { canonicalJson, sha256Hex } from "../../src/util/crypto.js";
import { createApp, listen, rawBody, route } from "../../src/util/http.js";
import { verifySignedRequest } from "../../src/util/sign.js";

// Local stand-in for every network KINETIC touches, so the full flow runs offline.
// Where it is cheap, it speaks the real wire format (Bee /bytes, the x402 facilitator API,
// the Hedera mirror REST API, the 0G router), so the same client code runs against it.
// It is a test double: no consensus and no persistence.

const NETWORK = "kinetic:devnet";
const FEE_PAYER = "0.0.4400";

interface Tx {
  transaction_id: string;
  name: string;
  result: "SUCCESS";
  consensus_timestamp: string;
  transfers: { account: string; amount: string }[];
  memo: string;
}

interface Entity {
  key: string;
  owner: string;
  /** Who created it: never changes (Arkiv's $creator). */
  creator: string;
  /** Created with Arkiv's readonly flag: its attributes can never change. */
  readonly?: boolean;
  createdAt: number;
  attrs: Record<string, WireAttr>;
  payload: unknown;
  expiresAt: number;
}

export interface DevnetOptions {
  port: number;
  /** The vault's verifier set (set later with setVerifiers when the keys aren't known yet). */
  verifiers?: string[];
  /** Signatures to propose a slash (default: a majority) and to decide a dispute (default: all). */
  threshold?: number;
  disputeThreshold?: number;
  withdrawDelaySeconds?: number;
  /** Default 0: a slash can be executed as soon as it is proposed. */
  disputeWindowSeconds?: number;
  resolveTimeoutSeconds?: number;
  minChallengeTinybar?: bigint;
  /** The 0G router's reference model answers every item with a different label: honest providers disagree with it. */
  referenceDisagrees?: boolean;
  zerogCredits?: number;
  /** 0G Compute providers to stand up, each with its own address and TEE signer. */
  /** `relays`: a centralized 0G provider whose TEE relays to this outside cloud, as some testnet ones do. */
  zgProviders?: { model: string; verifiability?: string; failAfter?: number; relays?: string }[];
  /** The 0G router has no TeeML provider: `private` requests get 503 no_provider_for_trust_mode, `verified` ones a TeeTLS relay. */
  routerNoTeeML?: boolean;
  /** The router's providers' TEE signatures don't recover to their registered signers. */
  routerBadTeeSignature?: boolean;
  /** A postage batch on the devnet chain: client-side stamps must be for it and signed by its owner. */
  postageBatch?: { id: string; owner: string };
}

const DEFAULT_ZG_PROVIDERS: NonNullable<DevnetOptions["zgProviders"]> = [{ model: "devnet-0gm" }, { model: "devnet-qwen" }, { model: "devnet-gemma" }];

/** The devnet vault's stand-in address and chain id, which verdict signatures are bound to. */
export const DEVNET_VAULT = { address: "0x000000000000000000000000000000000000ba57", chainId: 31337 };

export interface Devnet {
  url: string;
  /** Sets the vault's verifiers and, optionally, its quorums. */
  setVerifiers(addresses: string[], threshold?: number, disputeThreshold?: number): void;
  /** Moves the vault's clock forward, for dispute windows and timeouts. */
  advanceVaultClock(seconds: number): void;
  fund(address: string, tinybar: bigint): void;
  balanceOf(address: string): bigint;
  /** Addresses of the devnet's 0G Compute providers, lower-case. */
  zgProviders: string[];
  /** Takes a 0G Compute provider down (503 on every request) or back up. */
  setZgDown(provider: string, down: boolean): void;
  /** Chats a 0G Compute provider has served. */
  zgServed(provider: string): number;
  close(): Promise<void>;
}

export async function startDevnet(opts: DevnetOptions): Promise<Devnet> {
  const quorum = { verifiers: (opts.verifiers ?? []).map((v) => v.toLowerCase()), threshold: opts.threshold, disputeThreshold: opts.disputeThreshold };
  let clockSkew = 0;
  const balances = new Map<string, bigint>();
  const txs = new Map<string, Tx>();
  const nonces = new Set<string>();
  const settledNonces = new Map<string, string>();
  const bonds = new Map<string, { amount: bigint; unlockAt: number; slashed: boolean; pending: number }>();
  type DevSlash = { id: string; provider: string; buyer: string; refund: bigint; challenge: bigint; proposedAt: number; disputedAt: number; status: "proposed" | "disputed" | "executed" | "overturned" | "cancelled" };
  const slashes = new Map<string, DevSlash>();
  let burned = 0n;
  const topics = new Map<string, { seq: number; ts: string; message: string; running: string }[]>();
  const entities = new Map<string, Entity>();
  const blobs = new Map<string, Buffer>();
  let credits = opts.zerogCredits ?? 1_000_000;
  let nanos = 0;
  let entityNonce = 0;

  const now = () => Math.floor(Date.now() / 1000);
  const balance = (a: string) => balances.get(a.toLowerCase()) ?? 0n;
  const credit = (a: string, v: bigint) => balances.set(a.toLowerCase(), balance(a) + v);
  const record = (name: string, transfers: [string, bigint][], memo = ""): Tx => {
    const s = now();
    const n = (nanos = (nanos + 1) % 1_000_000_000);
    const tx: Tx = {
      transaction_id: `${FEE_PAYER}@${s}.${String(n).padStart(9, "0")}`,
      name,
      result: "SUCCESS",
      consensus_timestamp: `${s}.${String(n).padStart(9, "0")}`,
      transfers: transfers.map(([account, amount]) => ({ account, amount: amount.toString() })),
      memo,
    };
    txs.set(mirrorTransactionId(tx.transaction_id), tx);
    return tx;
  };
  const transfer = (from: string, to: string, amount: bigint, name: string, memo = "") => {
    if (balance(from) < amount) throw new Error(`insufficient balance: ${from}`);
    credit(from, -amount);
    credit(to, amount);
    return record(name, [[from, -amount], [to, amount]], memo);
  };
  const live = (e: Entity) => e.expiresAt > Date.now();

  const app = createApp();

  // ── Faucet and ledger ──
  app.post("/devnet/faucet", (req, res) => {
    const address = String(req.body.address ?? "").toLowerCase();
    const amount = BigInt(req.body.amount ?? 10_000_000_000n);
    credit(address, amount);
    res.json({ address, balance: balance(address) });
  });
  app.get("/devnet/accounts/:address", (req, res) => void res.json({ address: req.params.address, balance: balance(req.params.address) }));

  // ── x402 facilitator (exact scheme, signed transfer authorizations) ──
  type Authorization = { from: string; to: string; amount: string; asset: string; network: string; nonce: string; validBefore: number };
  const check = async (body: { paymentPayload: { payload: { authorization: Authorization; signature: Hex } }; paymentRequirements: { payTo: string; amount: string; asset: string; network: string } }) => {
    const { authorization: auth, signature } = body.paymentPayload.payload ?? ({} as never);
    const reqs = body.paymentRequirements;
    if (!auth || !signature) return "missing authorization";
    if (auth.network !== NETWORK || reqs.network !== NETWORK) return "wrong network";
    if (auth.to.toLowerCase() !== reqs.payTo.toLowerCase() || auth.amount !== reqs.amount || auth.asset !== reqs.asset) return "authorization does not match requirements";
    if (auth.validBefore < now()) return "authorization expired";
    if (nonces.has(auth.nonce)) return "nonce already used";
    const signer = await recoverMessageAddress({ message: canonicalJson(auth), signature });
    if (signer.toLowerCase() !== auth.from.toLowerCase()) return "bad signature";
    if (balance(auth.from) < BigInt(auth.amount)) return "insufficient balance";
    return null;
  };
  app.get("/facilitator/supported", (_req, res) => {
    res.json({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK, extra: { feePayer: FEE_PAYER } }], extensions: [], signers: { "kinetic:*": [FEE_PAYER] } });
  });
  app.post(
    "/facilitator/verify",
    route(async (req, res) => {
      const problem = await check(req.body);
      res.json(problem ? { isValid: false, invalidReason: problem } : { isValid: true, payer: req.body.paymentPayload.payload.authorization.from });
    }),
  );
  app.post(
    "/facilitator/settle",
    route(async (req, res) => {
      const problem = await check(req.body);
      if (problem) return void res.json({ success: false, errorReason: problem, transaction: "", network: NETWORK });
      const auth = req.body.paymentPayload.payload.authorization as Authorization;
      nonces.add(auth.nonce);
      const tx = transfer(auth.from, auth.to, BigInt(auth.amount), "CRYPTOTRANSFER", `x402:${auth.nonce}`);
      settledNonces.set(auth.nonce, tx.transaction_id);
      res.json({ success: true, transaction: tx.transaction_id, network: NETWORK, payer: auth.from.toLowerCase(), amount: auth.amount });
    }),
  );

  // Devnet-only: lets a payer find out whether a payment whose response it lost was settled.
  app.get("/facilitator/settled/:nonce", (req, res) => {
    const transaction = settledNonces.get(req.params.nonce);
    res.json({ settled: transaction !== undefined, transaction });
  });

  // ── Hedera mirror node REST (subset) ──
  app.get("/mirror/api/v1/transactions/:id", (req, res) => {
    const tx = txs.get(req.params.id);
    if (!tx) return void res.status(404).json({ _status: { messages: [{ message: "Not found" }] } });
    res.json({ transactions: [tx] });
  });
  app.get("/mirror/api/v1/topics/:topic/messages", (req, res) => {
    const list = topics.get(req.params.topic) ?? [];
    // The real mirror node caps pages at 100; the devnet allows more so tests can read a whole job.
    const limit = Math.min(Number(req.query.limit ?? 25), 1000);
    const desc = req.query.order === "desc";
    let ordered = desc ? [...list].reverse() : list;
    // Paging as on the real mirror node: sequencenumber=lt:N / gt:N, and a `next` link.
    const bound = String(req.query.sequencenumber ?? "").match(/^(lt|gt):(\d+)$/);
    if (bound) ordered = ordered.filter((m) => (bound[1] === "lt" ? m.seq < Number(bound[2]) : m.seq > Number(bound[2])));
    const page = ordered.slice(0, limit);
    const next =
      ordered.length > limit ? `/api/v1/topics/${req.params.topic}/messages?limit=${limit}&order=${desc ? "desc" : "asc"}&sequencenumber=${desc ? "lt" : "gt"}:${page.at(-1)!.seq}` : null;
    res.json({
      messages: page.map((m) => ({
        consensus_timestamp: m.ts,
        topic_id: req.params.topic,
        sequence_number: m.seq,
        running_hash: m.running,
        message: Buffer.from(m.message).toString("base64"),
      })),
      links: { next },
    });
  });

  // ── HCS submit ──
  app.post("/devnet/hcs/:topic/messages", (req, res) => {
    const list = topics.get(req.params.topic) ?? [];
    const prev = list.at(-1)?.running ?? "";
    const message = String(req.body.message ?? "");
    const entry = { seq: list.length + 1, ts: `${now()}.${String(++nanos).padStart(9, "0")}`, message, running: createHash("sha384").update(prev + message).digest("hex") };
    list.push(entry);
    topics.set(req.params.topic, list);
    res.json({ sequence: entry.seq });
  });

  // ── Bond vault (same rules as contracts/KineticBondVault.sol) ──
  const signed = (fn: (signer: string, body: any) => unknown) =>
    route(async (req, res) => {
      let signer: string;
      try {
        signer = await verifySignedRequest(req.headers, rawBody(req));
      } catch (err) {
        return void res.status(401).json({ error: (err as Error).message });
      }
      try {
        res.json(await fn(signer, req.body));
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    });
  const vaultNow = () => Math.floor(Date.now() / 1000) + clockSkew;
  const rules = () => {
    const n = quorum.verifiers.length;
    return {
      ...DEVNET_VAULT,
      verifiers: quorum.verifiers,
      threshold: quorum.threshold ?? Math.floor(n / 2) + 1,
      disputeThreshold: quorum.disputeThreshold ?? n,
      disputeWindowSeconds: opts.disputeWindowSeconds ?? 0,
      resolveTimeoutSeconds: opts.resolveTimeoutSeconds ?? 600,
      minChallengeTinybar: (opts.minChallengeTinybar ?? 10_000_000n).toString(),
    };
  };
  // As the contract: distinct verifiers, sorted by address, at least `need` of them.
  const requireQuorum = async (digest: Hex, signatures: Hex[], need: number) => {
    const signers: string[] = [];
    for (const signature of signatures) signers.push((await recoverMessageAddress({ message: { raw: digest }, signature })).toLowerCase());
    for (let i = 0; i < signers.length; i++) {
      if (i > 0 && BigInt(signers[i]) <= BigInt(signers[i - 1])) throw new Error("SignersNotSorted");
      if (!quorum.verifiers.includes(signers[i])) throw new Error(`NotVerifier(${signers[i]})`);
    }
    if (signers.length < need) throw new Error(`NoQuorum(${signers.length},${need})`);
  };
  const bondOf = (a: string) => bonds.get(a.toLowerCase()) ?? { amount: 0n, unlockAt: 0, slashed: false, pending: 0 };
  const burnIfSettled = (provider: string) => {
    const b = bondOf(provider);
    if (!b.slashed || b.pending !== 0 || b.amount === 0n) return 0n;
    burned += b.amount;
    bonds.set(provider, { ...b, amount: 0n });
    return b.amount;
  };
  const execute = (s: DevSlash) => {
    const b = bondOf(s.provider);
    const paid = s.refund < b.amount ? s.refund : b.amount;
    bonds.set(s.provider, { ...b, amount: b.amount - paid, pending: b.pending - 1, slashed: true, unlockAt: 0 });
    const burnt = burnIfSettled(s.provider);
    const challenge = s.challenge;
    s.challenge = 0n;
    s.status = "executed";
    const tx = transfer("vault", s.buyer, paid + challenge, "CONTRACTCALL", `executeSlash(${s.id.slice(0, 18)})`);
    return { tx: tx.transaction_id, status: "executed", refund: paid.toString(), burned: burnt.toString(), challenge: challenge.toString() };
  };
  const release = (s: DevSlash, status: "overturned" | "cancelled") => {
    const b = bondOf(s.provider);
    bonds.set(s.provider, { ...b, pending: b.pending - 1 });
    burnIfSettled(s.provider);
    const challenge = s.challenge;
    s.challenge = 0n;
    s.status = status;
    const tx = challenge > 0n ? transfer("vault", s.provider, challenge, "CONTRACTCALL", `release(${s.id.slice(0, 18)})`) : record("CONTRACTCALL", [], `release(${s.id.slice(0, 18)})`);
    return { tx: tx.transaction_id, status, refund: "0", burned: "0", challenge: challenge.toString() };
  };
  const slashOrThrow = (id: unknown) => {
    const s = slashes.get(String(id).toLowerCase());
    if (!s) throw new Error("WrongStatus");
    return s;
  };

  app.get("/devnet/vault/info", (_req, res) => void res.json(rules()));
  app.get("/devnet/vault/bonds/:address", (req, res) => void res.json(bondOf(req.params.address)));
  app.get("/devnet/vault/burned", (_req, res) => void res.json({ burned: burned.toString() }));
  app.get("/devnet/vault/slashes/:id", (req, res) => {
    const s = slashes.get(req.params.id.toLowerCase());
    res.json({
      id: req.params.id,
      status: s?.status ?? "none",
      provider: s?.provider ?? "",
      buyer: s?.buyer ?? "",
      refundTinybar: (s?.refund ?? 0n).toString(),
      challengeTinybar: (s?.challenge ?? 0n).toString(),
      proposedAt: s?.proposedAt ?? 0,
      disputedAt: s?.disputedAt ?? 0,
    });
  });
  app.post(
    "/devnet/vault/bond",
    signed((signer, body) => {
      const b = bondOf(signer);
      if (b.slashed) throw new Error("ProviderSlashed");
      const amount = BigInt(body.amount);
      const tx = transfer(signer, "vault", amount, "CONTRACTCALL", "bond()");
      bonds.set(signer, { ...b, amount: b.amount + amount, unlockAt: 0 });
      return { tx: tx.transaction_id };
    }),
  );
  app.post(
    "/devnet/vault/request-withdraw",
    signed((signer) => {
      const b = bondOf(signer);
      if (b.amount === 0n) throw new Error("NothingBonded");
      const unlockAt = vaultNow() + (opts.withdrawDelaySeconds ?? 86_400);
      bonds.set(signer, { ...b, unlockAt });
      return { tx: record("CONTRACTCALL", [], "requestWithdraw()").transaction_id, unlockAt };
    }),
  );
  // Anyone may submit a slash; the verifier signatures are what count.
  app.post(
    "/devnet/vault/propose",
    signed(async (_signer, body) => {
      const v = { ...body.verdict, refundTinybar: BigInt(body.verdict.refundTinybar) } as SlashVerdict;
      await requireQuorum(verdictDigest(v, DEVNET_VAULT), body.signatures, rules().threshold);
      const provider = v.provider.toLowerCase();
      const id = slashIdOf(provider, v.jobId).toLowerCase();
      if (slashes.has(id)) throw new Error("AlreadySlashed");
      slashes.set(id, { id, provider, buyer: v.buyer.toLowerCase(), refund: v.refundTinybar, challenge: 0n, proposedAt: vaultNow(), disputedAt: 0, status: "proposed" });
      const b = bondOf(provider);
      bonds.set(provider, { ...b, pending: b.pending + 1 });
      return { tx: record("CONTRACTCALL", [], `proposeSlash(${provider},${v.jobId},${v.chunk})`).transaction_id, slashId: id };
    }),
  );
  app.post(
    "/devnet/vault/dispute",
    signed((signer, body) => {
      const s = slashOrThrow(body.slashId);
      if (s.status !== "proposed") throw new Error("WrongStatus");
      if (signer !== s.provider) throw new Error("NotProvider");
      if (vaultNow() >= s.proposedAt + rules().disputeWindowSeconds) throw new Error("WindowClosed");
      const challenge = BigInt(body.challenge);
      if (challenge < BigInt(rules().minChallengeTinybar)) throw new Error("ChallengeTooSmall");
      const tx = transfer(signer, "vault", challenge, "CONTRACTCALL", `dispute(${s.id.slice(0, 18)})`);
      Object.assign(s, { status: "disputed", disputedAt: vaultNow(), challenge });
      return { tx: tx.transaction_id };
    }),
  );
  app.post(
    "/devnet/vault/resolve",
    signed(async (_signer, body) => {
      const s = slashOrThrow(body.slashId);
      if (s.status !== "disputed") throw new Error("WrongStatus");
      await requireQuorum(resolutionDigest(s.id as Hex, Boolean(body.upheld), DEVNET_VAULT), body.signatures, rules().disputeThreshold);
      return body.upheld ? execute(s) : release(s, "overturned");
    }),
  );
  app.post(
    "/devnet/vault/execute",
    signed((_signer, body) => {
      const s = slashOrThrow(body.slashId);
      const r = rules();
      if (s.status === "proposed") {
        if (vaultNow() < s.proposedAt + r.disputeWindowSeconds) throw new Error(`NotYet(${s.proposedAt + r.disputeWindowSeconds})`);
        return execute(s);
      }
      if (s.status === "disputed") {
        if (vaultNow() < s.disputedAt + r.resolveTimeoutSeconds) throw new Error(`NotYet(${s.disputedAt + r.resolveTimeoutSeconds})`);
        return release(s, "cancelled");
      }
      throw new Error("WrongStatus");
    }),
  );
  // HIP-351 seeds as the vault keeps them (drawSeed): verifiers only, one per tag, with the draw's time.
  const seeds = new Map<string, { seed: Hex; drawnAt: number; tx: string }>();
  app.get("/devnet/vault/seeds/:tag", (req, res) => void res.json(seeds.get(req.params.tag.toLowerCase()) ?? { seed: null, drawnAt: 0 }));
  app.post(
    "/devnet/vault/seed",
    signed((signer, body) => {
      if (!quorum.verifiers.includes(signer)) throw new Error(`NotVerifier(${signer})`);
      const tag = String(body.tag).toLowerCase();
      if (seeds.has(tag)) throw new Error("AlreadyDrawn");
      const drawn = { seed: `0x${randomBytes(32).toString("hex")}` as Hex, drawnAt: vaultNow(), tx: record("CONTRACTCALL", [], `drawSeed(${tag.slice(0, 18)})`).transaction_id };
      seeds.set(tag, drawn);
      return drawn;
    }),
  );

  // ── Arkiv entities ──
  // Same charset the chain enforces: lower-case letter first, then [a-z0-9._-]. The SDK's
  // client-side check also allows upper case, but the chain rejects it (Ident32InvalidByte).
  const checkNames = (attrs: Record<string, unknown> = {}) => {
    for (const [name, value] of Object.entries(attrs)) {
      if (!/^[a-z][a-z0-9._-]*$/.test(name)) throw new Error(`Ident32InvalidByte: attribute name ${name}`);
      // Like the SDK and chain: string attribute values are capped at 128 UTF-8 bytes.
      if (typeof value === "string" && Buffer.byteLength(value, "utf8") > 128) throw new Error(`InvalidValueError: attribute ${name} exceeds the 128-byte limit on a str`);
    }
  };
  // Entity events, as Arkiv's watcher reports them: one per operation, none on expiry.
  const arkivEvents: { seq: number; type: string; key: string; owner: string; expiresAt?: number; readonly?: boolean }[] = [];
  let eventSeq = 0;
  const emit = (type: string, e: Entity, extra: { expiresAt?: number; readonly?: boolean } = {}) => {
    arkivEvents.push({ seq: ++eventSeq, type, key: e.key, owner: e.owner, ...extra });
    if (arkivEvents.length > 5000) arkivEvents.splice(0, arkivEvents.length - 5000);
  };
  app.post(
    "/arkiv/create",
    signed((signer, body) => {
      checkNames(body.attrs);
      const key = "0x" + sha256Hex(`${signer}:${++entityNonce}:${randomBytes(8).toString("hex")}`);
      const e: Entity = { key, owner: signer, creator: signer, ...(body.readonly ? { readonly: true } : {}), createdAt: Date.now(), attrs: body.attrs, payload: body.payload ?? {}, expiresAt: Date.now() + Number(body.ttlSeconds) * 1000 };
      entities.set(key, e);
      emit("created", e, { expiresAt: e.expiresAt, ...(e.readonly ? { readonly: true } : {}) });
      return { key };
    }),
  );
  const owned = (signer: string, key: string) => {
    const e = entities.get(key);
    if (!e || !live(e)) throw new Error("NoEntityFound");
    if (e.owner !== signer) throw new Error("not the entity owner");
    return e;
  };
  app.post(
    "/arkiv/patch",
    signed((signer, body) => {
      const e = owned(signer, body.key);
      // Arkiv's own words for a patch of a readonly entity.
      if (e.readonly) throw new Error(`entity ${e.key} was created readonly, so its contents can never change`);
      checkNames(body.attrs);
      e.attrs = { ...e.attrs, ...body.attrs };
      if (body.payload !== undefined) e.payload = body.payload;
      emit("patched", e);
      return { ok: true };
    }),
  );
  app.post(
    "/arkiv/extend",
    signed((signer, body) => {
      const e = owned(signer, body.key);
      e.expiresAt = Date.now() + Number(body.ttlSeconds) * 1000;
      emit("extended", e, { expiresAt: e.expiresAt });
      return { ok: true };
    }),
  );
  app.post(
    "/arkiv/delete",
    signed((signer, body) => {
      const e = owned(signer, body.key);
      entities.delete(body.key);
      emit("deleted", e);
      return { ok: true };
    }),
  );
  const same = (a: WireAttr | undefined, b: WireAttr) =>
    a !== undefined && (typeof a === "string" ? a === b : typeof b !== "string" && a.u64 === b.u64);
  const matches = (e: Entity, where: Record<string, WireAttr>) => Object.entries(where).every(([k, v]) => same(e.attrs[k], v));
  // Sort key: a system field ($expiresAt, $createdAt, $key) or an attribute (u64 numerically).
  const sortValue = (e: Entity, attr: string): bigint | string => {
    if (attr === "$expiresAt") return BigInt(e.expiresAt);
    if (attr === "$createdAt") return BigInt(e.createdAt);
    if (attr === "$key") return e.key;
    const v = e.attrs[attr];
    return v === undefined ? "" : typeof v === "string" ? v : BigInt(v.u64);
  };
  app.post("/arkiv/query", (req, res) => {
    const where = (req.body.where ?? {}) as Record<string, WireAttr>;
    // At least one of these must also hold (a named schema's tag, or a legacy kind).
    const anyOf = (req.body.or ?? []) as Record<string, WireAttr>[];
    const owner = req.body.owner ? String(req.body.owner).toLowerCase() : undefined;
    const creator = req.body.creator ? String(req.body.creator).toLowerCase() : undefined;
    const limit = Number(req.body.limit ?? 1000);
    const orderBy = req.body.orderBy as { attr: string; desc?: boolean } | undefined;
    const all = [...entities.values()].filter(
      (e) => live(e) && (!owner || e.owner === owner) && (!creator || e.creator === creator) && matches(e, where) && (anyOf.length === 0 || anyOf.some((w) => matches(e, w))),
    );
    if (orderBy) {
      const dir = orderBy.desc ? -1 : 1;
      all.sort((a, b) => {
        const x = sortValue(a, orderBy.attr);
        const y = sortValue(b, orderBy.attr);
        return x < y ? -dir : x > y ? dir : 0;
      });
    }
    res.json({ entities: all.slice(0, limit), total: all.length });
  });
  app.post("/arkiv/get", (req, res) => {
    const e = entities.get(String(req.body.key));
    res.json({ entity: e && live(e) ? e : null });
  });
  // The event log after `after`; after=-1 just reports the head (a watcher starts there).
  app.get("/arkiv/events", (req, res) => {
    const after = Number(req.query.after ?? -1);
    res.json({ events: after < 0 ? [] : arkivEvents.filter((e) => e.seq > after), seq: eventSeq });
  });

  // ── 0G Storage (stand-in): files by root; the root here is a sha256, not 0G's Merkle root ──
  const zgFiles = new Map<string, Buffer>();
  app.post("/zgs/upload", express.raw({ type: () => true, limit: "20mb" }), (req, res) => {
    const data = Buffer.from(req.body as Buffer);
    const root = `0x${sha256Hex(data)}`;
    const tx = zgFiles.has(root) ? "" : `0x${randomBytes(32).toString("hex")}`;
    zgFiles.set(root, data);
    res.json({ root, ...(tx ? { tx } : {}) });
  });
  app.get("/zgs/:root", (req, res) => {
    const data = zgFiles.get(String(req.params.root).toLowerCase());
    if (!data) return void res.status(404).json({ error: "file not found" });
    res.type("application/octet-stream").send(data);
  });

  // ── Swarm Bee /bytes ──
  // Unencrypted uploads are stored as real content-addressed chunks, so clients can fetch and
  // check them chunk by chunk. An encrypted reference is 128 hex (address plus decryption key)
  // and is kept whole.
  const rawChunks = new Map<string, Uint8Array>();
  app.post("/bee/bytes", express.raw({ type: () => true, limit: "20mb" }), (req, res) => {
    const data = Buffer.from(req.body as Buffer);
    if (String(req.get("swarm-encrypt")) === "true") {
      const reference = sha256Hex(data) + randomBytes(32).toString("hex");
      blobs.set(reference, data);
      return void res.status(201).json({ reference });
    }
    const { reference, chunks } = swarmChunks(new Uint8Array(data));
    for (const [address, chunk] of chunks) rawChunks.set(address, chunk);
    blobs.set(reference, data);
    res.status(201).json({ reference });
  });
  app.get("/bee/bytes/:ref", (req, res) => {
    const data = blobs.get(req.params.ref);
    if (!data) return void res.status(404).json({ message: "Not Found" });
    res.type("application/octet-stream").send(data);
  });
  app.get("/bee/chunks/:address", (req, res) => {
    const chunk = rawChunks.get(req.params.address.toLowerCase());
    if (!chunk) return void res.status(404).json({ message: "Not Found" });
    res.type("application/octet-stream").send(Buffer.from(chunk));
  });

  // Client-side postage stamps, as Bee checks them: signed for this very chunk by the batch's
  // owner, and each (batch, bucket, slot) used once, as in an immutable batch.
  const stampSlots = new Map<string, string>();
  const checkStamp = async (stamp: string | undefined, address: string): Promise<string | undefined> => {
    if (!stamp) return undefined;
    try {
      const s = await readStamp(stamp, address);
      if (opts.postageBatch && (s.batchId !== opts.postageBatch.id.replace(/^0x/, "").toLowerCase() || s.issuer !== opts.postageBatch.owner.replace(/^0x/, "").toLowerCase())) return "invalid batch id";
      const slot = `${s.batchId}:${s.bucket}:${s.slot}`;
      if ((stampSlots.get(slot) ?? address) !== address) return "stamp index already used";
      stampSlots.set(slot, address);
      return undefined;
    } catch (err) {
      return `invalid stamp: ${(err as Error).message}`;
    }
  };
  app.post("/bee/chunks", express.raw({ type: () => true, limit: "1mb" }), async (req, res) => {
    const chunk = new Uint8Array(req.body as Buffer);
    if (chunk.length < 8 || chunk.length > 8 + 4096) return void res.status(400).json({ message: "invalid chunk size" });
    const address = contentAddress(chunk);
    const bad = await checkStamp(req.get("swarm-postage-stamp"), address);
    if (bad) return void res.status(400).json({ message: bad });
    rawChunks.set(address, chunk);
    res.status(201).json({ reference: address });
  });

  // Single-owner chunks and feeds (v1 updates: timestamp || reference), with Bee's lookup.
  app.post("/bee/soc/:owner/:id", express.raw({ type: () => true, limit: "1mb" }), async (req, res) => {
    const owner = req.params.owner.toLowerCase();
    const id = Buffer.from(req.params.id, "hex");
    const chunk = new Uint8Array(Buffer.concat([id, Buffer.from(String(req.query.sig ?? ""), "hex"), req.body as Buffer]));
    const address = socAddress(id, owner);
    try {
      await readSoc(chunk, address);
    } catch {
      return void res.status(401).json({ message: "invalid chunk" });
    }
    const bad = await checkStamp(req.get("swarm-postage-stamp"), address);
    if (bad) return void res.status(400).json({ message: bad });
    rawChunks.set(address, chunk);
    res.status(201).json({ reference: address });
  });
  const feedManifests = new Map<string, { owner: string; topic: string }>();
  const bzzFiles = new Map<string, { data: Buffer; contentType: string }>();
  const latestFeed = (owner: string, topic: string) => {
    let i = 0;
    while (rawChunks.has(feedUpdateAddress(owner, topic, i))) i++;
    return i - 1;
  };
  const feedTarget = (owner: string, topic: string, index: number) => Buffer.from(rawChunks.get(feedUpdateAddress(owner, topic, index))!.subarray(32 + 65 + 8 + 8)).toString("hex");
  app.get("/bee/feeds/:owner/:topic", (req, res) => {
    const owner = req.params.owner.toLowerCase();
    const topic = req.params.topic.toLowerCase();
    const index = latestFeed(owner, topic);
    if (index < 0) return void res.status(404).json({ code: 404, message: "no update found" });
    const target = feedTarget(owner, topic, index);
    res.set("swarm-feed-index", index.toString(16).padStart(16, "0"));
    res.set("swarm-feed-index-next", (index + 1).toString(16).padStart(16, "0"));
    res.type("application/octet-stream").send(blobs.get(target) ?? bzzFiles.get(target)?.data ?? Buffer.alloc(0));
  });
  app.post("/bee/feeds/:owner/:topic", (req, res) => {
    const reference = sha256Hex(`feed-manifest:${req.params.owner.toLowerCase()}:${req.params.topic.toLowerCase()}`);
    feedManifests.set(reference, { owner: req.params.owner.toLowerCase(), topic: req.params.topic.toLowerCase() });
    res.status(201).json({ reference });
  });
  // Single-file /bzz uploads; a feed manifest resolves to what its newest update points at.
  app.post("/bee/bzz", express.raw({ type: () => true, limit: "20mb" }), (req, res) => {
    // express.json (app-wide) may have parsed a JSON body already; its raw text is kept.
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.from((req as unknown as { rawBody?: string }).rawBody ?? "", "utf8");
    const reference = sha256Hex(`bzz:${String(req.query.name ?? "")}:${sha256Hex(data)}`);
    bzzFiles.set(reference, { data, contentType: req.get("content-type") ?? "application/octet-stream" });
    res.status(201).json({ reference });
  });
  app.get("/bee/bzz/:ref", (req, res) => {
    let ref = req.params.ref.toLowerCase();
    const feed = feedManifests.get(ref);
    if (feed) {
      const index = latestFeed(feed.owner, feed.topic);
      if (index < 0) return void res.status(404).json({ message: "no update found" });
      ref = feedTarget(feed.owner, feed.topic, index);
    }
    const file = bzzFiles.get(ref);
    if (!file) return void res.status(404).json({ message: "Not Found" });
    res.type(file.contentType).send(file.data);
  });

  // ── 0G router (OpenAI-compatible) ──
  const reference = (task: Parameters<typeof heuristicRun>[0], items: Parameters<typeof heuristicRun>[1]) => {
    const out = heuristicRun(task, items).items;
    if (!opts.referenceDisagrees) return out;
    const names = (task.labels ?? []).map((l) => l.name);
    return out.map((o) => ({ ...o, label: names[(names.indexOf(o.label ?? "") + 1) % names.length] }));
  };
  // The router's own 0G Compute providers, registered like any other (in /0gc/services): a TeeML
  // node for `private`, and a TeeTLS relay that only `verified` admits. As router-api.0g.ai does,
  // each exchange is sealed to the enclave, so the TEE signs ciphertext hashes
  // (zg-sig-v1/e2ee-ct, 0g-pc-e2ee SPEC §8), plus a routing proof for the relay.
  const routerTee = (seed: string, relays?: string) => ({
    address: privateKeyToAccount(`0x${createHash("sha256").update(seed).digest("hex")}`).address.toLowerCase(),
    tee: privateKeyToAccount(generatePrivateKey()),
    relays,
    chats: new Map<string, { text: string; signature: string; routing_proof?: { text: string; signature: string } }>(),
  });
  const routerProviders = [routerTee("devnet-0g-router-teeml"), routerTee("devnet-0g-router-teetls", "devnet-cloud")];
  app.post(
    "/0g/v1/chat/completions",
    route(async (req, res) => {
      const user = (req.body.messages as { role: string; content: string }[]).find((m) => m.role === "user")?.content ?? "";
      const parsed = parseTaskBlock(user);
      if (!parsed) return void res.status(400).json({ error: { message: "devnet 0G only answers KINETIC task prompts" } });
      const tier = String(req.get("x-0g-provider-trust-mode") ?? "");
      if (tier === "private" && opts.routerNoTeeML) return void res.status(503).json({ error: { code: "no_provider_for_trust_mode", message: "no provider available for trust mode: tier=private" } });
      const cost = 25;
      if (credits < cost) return void res.status(402).json({ error: { message: "out of 0G credits" } });
      credits -= cost;
      const requestId = `devnet-${randomBytes(6).toString("hex")}`;
      const p = routerProviders[opts.routerNoTeeML ? 1 : 0]!;
      const chatId = randomBytes(16).toString("hex");
      const halves = `${sha256Hex(randomBytes(32))}:${sha256Hex(randomBytes(32))}`;
      const signer = opts.routerBadTeeSignature ? privateKeyToAccount(generatePrivateKey()) : p.tee;
      const text = `zg-sig-v1/e2ee-ct:${halves}`;
      const proofText = `${halves}:centralized:${p.relays}:${sha256Hex(String(p.relays))}`;
      p.chats.set(chatId, { text, signature: await signer.signMessage({ message: text }), ...(p.relays ? { routing_proof: { text: proofText, signature: await signer.signMessage({ message: proofText }) } } : {}) });
      res
        .set("X-Request-ID", requestId)
        .set("ZG-Res-Key", chatId)
        .set("X-0G-E2EE", "sealed")
        .json({
          id: `chatcmpl-${chatId}`,
          model: req.body.model,
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ results: reference(parsed.task, parsed.items) }) } }],
          x_0g_trace: { request_id: requestId, provider: p.address, provider_identity: p.relays ?? "devnet", tee_verified: true, billing: { currency: "usd", total_cost_usd_micro: String(cost) } },
        });
    }),
  );
  app.get("/0g/v1/account/balance", (_req, res) => void res.json({ credits }));

  // ── 0G Compute: individual providers, each with its own TEE signer, as on the 0G chain ──
  // Same wire format as a real 0G provider's proxy: chat completions with a ZG-Res-Key header,
  // and /v1/proxy/signature/:chatId serving the TEE's signature over that chat.
  const zgBase = `http://localhost:${opts.port}/0gc`;
  const zg = new Map<string, { tee: ReturnType<typeof privateKeyToAccount>; model: string; verifiability: string; failAfter?: number; relays?: string; down: boolean; served: number; chats: Map<string, { text: string; signature: string }> }>();
  for (const [i, spec] of (opts.zgProviders ?? DEFAULT_ZG_PROVIDERS).entries()) {
    const address = privateKeyToAccount(`0x${createHash("sha256").update(`devnet-0g-provider-${i}`).digest("hex")}`).address.toLowerCase();
    zg.set(address, { tee: privateKeyToAccount(generatePrivateKey()), model: spec.model, verifiability: spec.verifiability ?? "TeeML", failAfter: spec.failAfter, relays: spec.relays, down: false, served: 0, chats: new Map() });
  }
  app.get("/0gc/services", (_req, res) => {
    res.json([
      ...[...zg.entries()].map(([provider, p]) => ({
        provider,
        serviceType: "chatbot",
        url: `${zgBase}/p/${provider}`,
        model: p.model,
        verifiability: p.verifiability,
        teeSignerAddress: p.tee.address,
        teeSignerAcknowledged: true,
        additionalInfo: JSON.stringify(p.relays ? { ProviderType: "centralized", ProviderIdentity: p.relays, TargetSeparated: true } : { ProviderType: "decentralized" }),
      })),
      ...routerProviders.map((p) => ({
        provider: p.address,
        serviceType: "chatbot",
        url: `${zgBase}/p/${p.address}`,
        model: "devnet-reference",
        verifiability: "TeeML",
        teeSignerAddress: p.tee.address,
        teeSignerAcknowledged: true,
        additionalInfo: JSON.stringify(p.relays ? { ProviderType: "centralized", ProviderIdentity: p.relays, TargetSeparated: true } : { ProviderType: "decentralized" }),
      })),
    ]);
  });
  app.post(
    "/0gc/p/:provider/v1/proxy/chat/completions",
    route(async (req, res) => {
      const p = zg.get(String(req.params.provider).toLowerCase());
      if (!p) return void res.status(404).json({ error: "no such 0G provider" });
      // Goes down for good once it has served failAfter chats.
      if (p.failAfter !== undefined && p.served >= p.failAfter) p.down = true;
      if (p.down) return void res.status(503).json({ error: "0G provider unavailable" });
      const user = (req.body.messages as { role: string; content: string }[]).find((m) => m.role === "user")?.content ?? "";
      const parsed = parseTaskBlock(user);
      if (!parsed) return void res.status(400).json({ error: "devnet 0G only answers KINETIC task prompts" });
      const content = JSON.stringify({ results: heuristicRun(parsed.task, parsed.items).items });
      const chatId = `chatcmpl-${randomBytes(8).toString("hex")}`;
      const body = JSON.stringify({ id: chatId, model: p.model, choices: [{ index: 0, message: { role: "assistant", content } }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
      // As the 0G broker does: the TEE signs sha256(request):sha256(the exact response bytes sent),
      // with the provider type, identity and upstream TLS fingerprint appended for a centralized relay.
      const hashes = `${sha256Hex(JSON.stringify(req.body))}:${sha256Hex(body)}`;
      const text = p.relays ? `${hashes}:centralized:${p.relays}:${sha256Hex(p.relays)}` : hashes;
      p.chats.set(chatId, { text, signature: await p.tee.signMessage({ message: text }) });
      p.served += 1;
      res.set("ZG-Res-Key", chatId).type("application/json").send(body);
    }),
  );
  app.get("/0gc/p/:provider/v1/proxy/signature/:chatId", (req, res) => {
    const address = String(req.params.provider).toLowerCase();
    const sig = (zg.get(address) ?? routerProviders.find((p) => p.address === address))?.chats.get(req.params.chatId);
    if (!sig) return void res.status(404).json({ error: "chat not found" });
    res.json(sig);
  });

  const server: Server = await listen(app, opts.port);
  return {
    url: `http://localhost:${opts.port}`,
    setVerifiers: (addresses, threshold, disputeThreshold) => {
      quorum.verifiers = addresses.map((a) => a.toLowerCase());
      quorum.threshold = threshold;
      quorum.disputeThreshold = disputeThreshold;
    },
    advanceVaultClock: (seconds) => void (clockSkew += seconds),
    fund: (address, tinybar) => void credit(address, tinybar),
    balanceOf: balance,
    zgProviders: [...zg.keys()],
    setZgDown: (provider, down) => void (zg.get(provider.toLowerCase())!.down = down),
    zgServed: (provider) => zg.get(provider.toLowerCase())?.served ?? 0,
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}

/** Tops a role's account up from the devnet faucet. */
export async function ensureDevnetFunds(svc: Services, tinybar = 10_000_000_000n): Promise<void> {
  if (svc.cfg.network !== "devnet") return;
  const res = await fetch(`${svc.cfg.devnetUrl}/devnet/accounts/${svc.address}`);
  const { balance } = (await res.json()) as { balance: string };
  if (BigInt(balance) >= tinybar / 10n) return;
  await fetch(`${svc.cfg.devnetUrl}/devnet/faucet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: svc.address, amount: tinybar.toString() }),
  });
}
