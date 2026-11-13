import { createPublicClient, type Attributes } from "@arkiv-network/sdk";
import { and, asc, eq, gt, or } from "@arkiv-network/sdk/query";
import { key, str } from "@arkiv-network/sdk/schema";
import { defineChain, hexToString, http, type Hex } from "viem";
import { replayAgentInfo, replayCanaries, replayEntities, replayHalt, replayModelPassport, replayReceipts, replayRuns, replayStart, replayStatus } from "./replay";

// Everything the dashboard shows is read from public sources: Arkiv entities (offers,
// claims, jobs, chunks, reputation) and HCS receipts through the Hedera mirror node.
// The verifier's /status says where to look and reports 0G use; its /canaries endpoint
// gives expected-vs-actual labels. The agent API only starts and stops jobs.

export const VERIFIER_URL = import.meta.env.VITE_VERIFIER_URL ?? "http://localhost:4500";

/**
 * Synthetic replay (replay.ts): the fallback for when the live networks can't be reached.
 * On with `?replay`, off with `?replay=0`; the choice is remembered. `VITE_REPLAY=1` forces it.
 * In replay nothing below touches the network, and nothing links to HashScan.
 */
export const REPLAY = (() => {
  if (import.meta.env.VITE_REPLAY === "1") return true;
  try {
    const q = new URLSearchParams(location.search).get("replay");
    if (q !== null) localStorage.setItem("kinetic.replay", q === "0" ? "0" : "1");
    return localStorage.getItem("kinetic.replay") === "1";
  } catch {
    return false;
  }
})();

/**
 * Presentation view (`?demo`), for recordings: hides the test-provider labels and providers from
 * earlier runs that no longer publish an offer. Everything shown is still read live.
 */
export const DEMO = (() => {
  try {
    return new URLSearchParams(location.search).has("demo");
  } catch {
    return false;
  }
})();

export function setReplay(on: boolean) {
  try {
    localStorage.setItem("kinetic.replay", on ? "1" : "0");
  } catch {
    // Private mode: the URL parameter below still carries it.
  }
  location.search = on ? "?replay" : "?replay=0";
}

/** Replay answers look like network answers: async, and a moment late. */
const replayed = <T,>(f: () => T): Promise<T> => new Promise((resolve, reject) => setTimeout(() => {
  try {
    resolve(f());
  } catch (err) {
    reject(err);
  }
}, 120));
export const AGENT_URL = import.meta.env.VITE_AGENT_URL ?? "http://localhost:4600";

export interface Status {
  network: "testnet";
  /** ERC-8004 on 0G Chain: the registries, and this verifier's own agent id. */
  erc8004?: { chainId: number; identityRegistry: string; reputationRegistry: string; explorerUrl: string; agentId?: number; tx?: string };
  verifier: string;
  hcsTopic: string;
  vault?: string;
  /** The verifier's HCS-14 Universal Agent ID. */
  uaid?: string;
  /** What x402 payments settle in: HBAR (asset 0.0.0). Older receipts may name the HTS token they settled in. */
  payment?: { asset: string; symbol: string; decimals: number };
  mirrorUrl: string;
  arkiv: { app: string; rpcUrl: string; chainId?: number; explorerUrl?: string };
  policy: { canaryRate: number; window: number; failLimit: number; minAgreement: number };
  zerog: { referenceRuns: number; spentUsdMicro: number; model: string; trustMode: string; balance: number | null };
  earnings: { feesTinybar: string; feePayments: number; feePerChunkTinybar: string };
  /** The 0G Storage indexer passports are served from (GET /file?root=). */
  storageGateway?: string;
  /** The bond vault's verifier set: who may sign slashes and Model Passports. */
  quorum?: { verifiers: string[]; threshold: number; cosigners: number };
  models?: { key: string; id: string; version: string; accuracy: number; passportRef: string; signers: number }[];
}

export interface Entity {
  key: string;
  owner: string;
  /** Who created it (Arkiv's $creator, which never changes). Absent from older verifiers. */
  creator?: string;
  attrs: Record<string, string | number>;
  payload: Record<string, unknown> | null;
  /** When it expires (unix ms, estimated from blocks). Absent from older verifiers. */
  expiresAtMs?: number;
}

/** Written by `who`: created by it (when the source says) and still owned by it. */
export const writtenBy = (e: Entity, who: string) => e.owner === who && (e.creator ?? e.owner) === who;

export type Kind = "offer" | "claim" | "job" | "chunk" | "reputation" | "model";

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`.trim());
  return res.json() as Promise<T>;
}

export const getStatus = () => (REPLAY ? replayed(replayStatus) : getJson<Status>(`${VERIFIER_URL}/status`));

let arkivClient: ReturnType<typeof createPublicClient> | null = null;

/** Arkiv Rabdi, the network a verifier that doesn't report its chain id is on. */
const RABDI_CHAIN_ID = 7794095;

function arkivReader(rpcUrl: string, chainId = RABDI_CHAIN_ID) {
  arkivClient ??= createPublicClient({
    chain: defineChain({ id: chainId, name: "Arkiv", nativeCurrency: { name: "Golem", symbol: "tGLM", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } }),
    transport: http(rpcUrl),
  });
  return arkivClient;
}

/** KINETIC keeps an entity's JSON payload in its `payload` bytes attribute (SDK 1.0 has no separate payload). */
function payloadOf(attributes: Attributes): Record<string, unknown> | null {
  const v = attributes.payload;
  if (!v || (v.type !== "bytes" && v.type !== "str")) return null;
  try {
    return JSON.parse(v.type === "bytes" ? hexToString(v.value) : v.value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function getEntities(status: Status, kind: Kind): Promise<Entity[]> {
  if (REPLAY) return replayed(() => replayEntities(kind));
  const { app, rpcUrl, chainId } = status.arkiv;
  // The verifier's cached Arkiv reads (one query per kind for every viewer, and the Arkiv
  // access key stays on the server). Older verifiers without the route: read Arkiv here.
  const res = await fetch(`${VERIFIER_URL}/arkiv/${kind}`);
  if (res.ok) return ((await res.json()) as { entities: Entity[] }).entities;
  if (res.status !== 404) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Arkiv read failed (${res.status})`);
  // Written through the kind's named schema, or (before it) tagged with a `kind` attribute.
  const match = or(and(eq("arkiv.schema", str(`kinetic.${kind}`)), eq("app", str(app))), and(eq("kind", str(kind)), eq("app", str(app))));
  const all: Entity[] = [];
  // Pages of 100 (the node's cap), keyed on $key, up to 2000 entities.
  let after: Hex | undefined;
  while (all.length < 2000) {
    const page = await arkivReader(rpcUrl, chainId)
      .select({ $key: true, $owner: true, $creator: true, $attributes: true })
      .where(after ? and(match, gt("$key", key(after))) : match)
      .orderBy(asc("$key"))
      .limit(100)
      .fetch();
    for (const e of page.entities) {
      all.push({
        key: e.$key,
        owner: e.$owner.toLowerCase(),
        creator: e.$creator.toLowerCase(),
        payload: payloadOf(e.$attributes),
        attrs: Object.fromEntries(
          Object.entries(e.$attributes)
            .filter(([k]) => k !== "payload" && k !== "arkiv.schema")
            // Typed addresses read back checksummed; KINETIC compares them lower-case ("" for none).
            .map(([k, v]) => [k, v.type === "addr" ? (/^0x0{40}$/.test(v.value) ? "" : v.value.toLowerCase()) : typeof v.value === "bigint" || typeof v.value === "number" ? Number(v.value) : String(v.value)]),
        ),
      });
    }
    if (page.entities.length < 100) break;
    after = page.entities[page.entities.length - 1]!.$key;
  }
  return all;
}

/**
 * Live Arkiv entities from the verifier's Server-Sent Events stream (GET /arkiv/events): a snapshot
 * of each kind, then each change as it happens (the verifier follows Arkiv's entity events).
 * Returns null where there is no stream (replay, no EventSource). onDown fires when it can't be
 * kept up (a verifier without the stream, or one that went away); the caller polls instead.
 */
export function streamEntities(kinds: Kind[], onKind: (kind: Kind, entities: Entity[]) => void, onDown: (why: string) => void): (() => void) | null {
  if (REPLAY || typeof EventSource === "undefined") return null;
  const maps = new Map<Kind, Map<string, Entity>>();
  const es = new EventSource(`${VERIFIER_URL}/arkiv/events?kinds=${kinds.join(",")}`);
  let snapshots = 0;
  let failures = 0;
  let done = false;
  const down = (why: string) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    es.close();
    onDown(why);
  };
  // Nothing within 15 s: no stream here (an older verifier answers 404, which closes it at once).
  const timer = setTimeout(() => snapshots === 0 && down("no event stream"), 15_000);
  es.addEventListener("snapshot", (m) => {
    snapshots += 1;
    failures = 0;
    const s = JSON.parse((m as MessageEvent<string>).data) as { kind: Kind; entities: Entity[] };
    maps.set(s.kind, new Map(s.entities.map((e) => [e.key, e])));
    onKind(s.kind, s.entities);
  });
  es.addEventListener("change", (m) => {
    const c = JSON.parse((m as MessageEvent<string>).data) as { kind: Kind; upserts: Entity[]; removes: string[] };
    const map = maps.get(c.kind);
    if (!map) return;
    for (const e of c.upserts) map.set(e.key, e);
    for (const k of c.removes) map.delete(k);
    onKind(c.kind, [...map.values()]);
  });
  // EventSource reconnects by itself (and gets fresh snapshots); give up after a few failures in a row.
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED || ++failures >= 4) down("event stream lost");
  };
  return () => {
    done = true;
    clearTimeout(timer);
    es.close();
  };
}

export type Receipt = { seq: number; ts: string; t: string; [k: string]: unknown };

/** HCS receipts, newest first, following mirror-node pages (100 per page) up to `max`. */
export async function getReceipts(status: Status, max = 400): Promise<Receipt[]> {
  if (REPLAY) return replayed(() => replayReceipts().slice(0, max));
  if (!status.hcsTopic) return [];
  const out: Receipt[] = [];
  let next: string | null = `/api/v1/topics/${status.hcsTopic}/messages?order=desc&limit=100`;
  while (next && out.length < max) {
    const res = await fetch(`${status.mirrorUrl}${next}`);
    if (!res.ok) break;
    const body = (await res.json()) as { messages: { sequence_number: number; consensus_timestamp: string; message: string }[]; links?: { next?: string | null } };
    for (const m of body.messages) {
      try {
        const bytes = Uint8Array.from(atob(m.message), (c) => c.charCodeAt(0));
        out.push({ seq: m.sequence_number, ts: m.consensus_timestamp, ...JSON.parse(new TextDecoder().decode(bytes)) });
      } catch {
        // Not a KINETIC receipt.
      }
    }
    next = body.links?.next ?? null;
  }
  return out;
}

// ── Verifier: canary evidence ──

export interface ItemOutput {
  id: string;
  label?: string;
  tags?: string[];
  fields?: Record<string, string | null>;
}

export interface CanaryResult {
  idx: number;
  provider: string;
  agreement: number;
  pass: boolean;
  requestId: string;
  model: string;
  zeroGProvider: string;
  expected: ItemOutput[];
  actual: ItemOutput[];
  /** The verifier's own check of the 0G reference run's TEE signature (src/integrations/zerog-tee.ts). */
  tee?: CanaryTee;
}

export interface CanaryTee {
  trustMode: string;
  fallback?: string;
  provider: string;
  providerType?: "decentralized" | "centralized";
  providerIdentity?: string;
  guarantee: "TeeML" | "TeeTLS" | "unknown";
  chatId: string;
  scheme?: string;
  signedText?: string;
  signedTextHash?: string;
  signature?: string;
  signer?: string;
  verification: "verified" | "invalid" | "unavailable";
  reason?: string;
  routerTeeVerified: boolean | null;
  costUsdMicro: number;
}

export const getCanaries = (jobId: string) =>
  REPLAY ? replayed(() => replayCanaries(jobId)) : getJson<{ canaries: CanaryResult[] }>(`${VERIFIER_URL}/jobs/${jobId}/canaries`).then((r) => r.canaries, () => [] as CanaryResult[]);

// ── Agent API: start and stop jobs ──

export interface AgentInfo {
  presets: { id: string; kind: string }[];
  maxItems: number;
  defaults: { maxPricePerChunk: string; maxJobSpend: string };
  network: string;
  halted: boolean;
  asset?: { id: string; symbol: string; decimals: number };
  uaid?: string;
  /** The buyer agent's Hedera account, which pays every job (agents from before this field don't send it). */
  account?: string;
}

/** An account's HBAR balance in tinybar, from the Hedera mirror node. */
export async function getHbarBalance(status: Status, account: string): Promise<number | null> {
  if (REPLAY || !/^\d+\.\d+\.\d+$/.test(account)) return null;
  const res = await fetch(`${status.mirrorUrl}/api/v1/accounts/${account}`);
  if (!res.ok) return null;
  const body = (await res.json()) as { balance?: { balance?: number } };
  return typeof body.balance?.balance === "number" ? body.balance.balance : null;
}

export interface Run {
  runId: string;
  jobId?: string;
  preset: string;
  /** The listed model the job ran, when one was chosen. */
  model?: { key: string; id: string; version: string };
  items: number;
  chunkSize: number;
  maxSpendTinybar: string;
  status: "starting" | "running" | "complete" | "incomplete" | "failed" | "halted";
  startedAt: number;
  finishedAt?: number;
  error?: string;
  /** The finished job's report (a subset of the agent's JobReport). */
  report?: {
    strategy?: string;
    passport?: { ref: string; url: string; attested: boolean; coverage: { verified: number; formatOnly: number; share: number } };
    chunks: number;
    providers: { name: string; status: string; promoted?: boolean; rank?: { score: number } }[];
    agreement?: { canaryRate: number; minAgreement: number; deadline?: string };
    outcome?: { met: boolean; notes: string[] };
    royaltyTinybar?: string;
    model?: { key: string; id: string; version: string; royaltyBps: number; payTo: string; royalty?: { amount: string; basis: string; tx: string } };
    paidTinybar?: string;
    refundedTinybar?: string;
    results?: { id: string; label?: string; tags?: string[]; fields?: Record<string, string | null> }[];
    /** One entry per accepted chunk (agents from before chunkLog existed don't send it). */
    chunkLog?: ChunkLogEntry[];
  };
}

/** An accepted chunk: who ran it, the x402 payment, how it was checked, and how fast it was. */
export interface ChunkLogEntry {
  idx: number;
  itemIds: string[];
  provider: string;
  name: string;
  payTx?: string;
  amount: string;
  check: "verified" | "format";
  known?: { items: number; correct: number };
  roundTripMs: number;
  /** Provider-reported and unsigned: a speed figure only. */
  usage?: { latencyMs: number; promptTokens?: number; completionTokens?: number };
}

/** Rules for a job, agreed before it starts. Anything left out uses the network's own. */
export type Tier = "basic" | "standard" | "high" | "confidential";

export interface AgreementTerms {
  canaryRate?: number;
  minAgreement?: number;
  deadlineSeconds?: number;
  tier?: Tier;
}

export type Strategy = "cheapest" | "balanced" | "fastest";

export const getAgentInfo = () => (REPLAY ? replayed(replayAgentInfo) : getJson<AgentInfo>(`${AGENT_URL}/presets`));
export const getRuns = () => (REPLAY ? replayed(replayRuns) : getJson<{ runs: Run[]; halted: boolean }>(`${AGENT_URL}/runs`));
export const startRun = (body: { preset?: string; model?: string; texts?: string[]; items: number; chunkSize: number; maxSpendTinybar: string; maxPriceTinybar: string; strategy?: Strategy; maxProviders?: number; agreement?: AgreementTerms }) =>
  REPLAY ? replayed(() => replayStart(body)) : getJson<Run>(`${AGENT_URL}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
// ── Model hub ──

export interface ModelTask {
  kind: "classify" | "extract" | "tag";
  instructions: string;
  labels?: { name: string; hint?: string }[];
  fields?: { name: string; hint?: string }[];
}

/** A model card, as the creator signed it. */
export interface ModelCard {
  kind: string;
  id: string;
  version: string;
  name: string;
  description: string;
  license: string;
  creator: { address: string; payTo: string };
  task: ModelTask;
  runtime: { engine: "0g" | "openai"; model: string };
  weights?: { format: string; files: { name: string; sha256: string; bytes: number; zgRoot?: string }[]; source?: string };
  royaltyBps: number;
  createdAt: string;
}

/** A listing in the model registry: an Arkiv `model` entity written by a vault verifier. */
export interface ModelListing {
  key: string;
  entityKey: string;
  owner: string;
  card: ModelCard;
  passportRef: string;
  passportDigest: string;
  accuracy: number;
  params?: number;
  weightsChecked: boolean;
  signers: string[];
}

export interface ModelPassport {
  kind: string;
  key: string;
  network: string;
  issuedAt: string;
  card: ModelCard;
  cardDigest: string;
  creatorSignature: string;
  weights:
    | { checked: true; ok: boolean; params: number; dtypes: string[]; files: { name: string; sha256: string; bytes: number; kind: string; tensors?: number; params?: number }[]; checks: { name: string; ok: boolean; detail?: string }[] }
    | { checked: false; reason: string };
  benchmark: { task: string; source: "verifier" | "creator"; items: number; itemsHash: string; correct: number; accuracy: number; minAccuracy: number; ranOn: string[] };
  fingerprint?: { task: string; answers: Record<string, string> };
  /** Passports issued before 2026-11-11 name a `swarmGateway` instead (kept as signed). */
  references: { hcsTopic: string; storageGateway?: string; swarmGateway?: string; vault?: string };
  limitations: string[];
  attestations: { verifiers: { address: string; signature: string }[] };
}

/** Listings from the snapshot's `model` entities, trusted only when a vault verifier wrote them. */
export function listingsOf(status: Status, entities: Entity[]): ModelListing[] {
  const verifiers = new Set([status.verifier, ...(status.quorum?.verifiers ?? [])].map((v) => v.toLowerCase()));
  const byKey = new Map<string, ModelListing>();
  for (const e of entities) {
    const p = e.payload as Partial<ModelListing> | null;
    if (!p?.card || !verifiers.has(e.owner) || !verifiers.has(e.creator ?? e.owner) || e.attrs.status !== "listed") continue;
    const key = String(e.attrs.mkey);
    byKey.set(key, {
      key,
      entityKey: e.key,
      owner: e.owner,
      card: p.card,
      passportRef: String(p.passportRef),
      passportDigest: String(p.passportDigest),
      accuracy: Number(e.attrs.accuracy ?? 0) / 100,
      ...(p.params !== undefined ? { params: p.params } : {}),
      weightsChecked: !!p.weightsChecked,
      signers: p.signers ?? [],
    });
  }
  return [...byKey.values()].sort((a, b) => a.card.name.localeCompare(b.card.name));
}

/** A listing's Model Passport, served from 0G Storage through the verifier (0G's indexer sends no CORS headers). */
export const getModelPassport = (listing: ModelListing) =>
  REPLAY ? replayed(() => replayModelPassport(listing)) : getJson<ModelPassport>(`${VERIFIER_URL}/models/${listing.key}/passport`);

/** Whose 0G key pays for the buyer agent's own 0G calls: the team's, or a signed-in user's. */
export const getZerogKeySource = () => REPLAY ? replayed(() => ({ source: "team" as const })) : getJson<{ source: "team" | "user" }>(`${AGENT_URL}/zerog-key`);
export const setZerogKey = (key: string) =>
  getJson<{ source: "team" | "user" }>(`${AGENT_URL}/zerog-key`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
export const resetZerogKey = () => getJson<{ source: "team" | "user" }>(`${AGENT_URL}/zerog-key`, { method: "DELETE" });

export const setHalted = (halted: boolean) => REPLAY ? replayed(() => replayHalt(halted)) : getJson<{ halted: boolean }>(`${AGENT_URL}/${halted ? "halt" : "resume"}`, { method: "POST" });

// ── Formatting ──

export const hbar = (tinybar: number | string | bigint | undefined) =>
  `${(Number(tinybar ?? 0) / 1e8).toFixed(5).replace(/0+$/, "").replace(/\.$/, "")} ℏ`;
export const short = (v: string | undefined, n = 6) => (!v ? "—" : v.length <= n * 2 + 1 ? v : `${v.slice(0, n)}…${v.slice(-4)}`);
export const toTinybar = (hbarValue: string) => BigInt(Math.round(Number(hbarValue || 0) * 1e8)).toString();

export const paysInToken = (status: Status) => !!status.payment && status.payment.asset !== "0.0.0";
export const paymentSymbol = (status: Status) => (paysInToken(status) ? status.payment!.symbol : "ℏ");

/** A payment amount (chunk price, x402 payment, verifier fee) in the payment asset. Refunds and bonds use hbar(). */
export function money(status: Status, units: number | string | bigint | undefined): string {
  if (!paysInToken(status)) return hbar(units);
  const { decimals, symbol } = status.payment!;
  const v = Number(units ?? 0) / 10 ** decimals;
  return `${v.toFixed(Math.min(decimals, 5)).replace(/0+$/, "").replace(/\.$/, "")} ${symbol}`;
}

/** An amount recorded on a receipt: `asset` is its HTS token id, absent for HBAR. */
export function amountOf(status: Status, units: number | string | bigint | undefined, asset?: unknown): string {
  if (!asset || asset === "0.0.0") return hbar(units);
  if (status.payment?.asset === asset) return money(status, units);
  return `${Number(units ?? 0)} units of ${String(asset)}`;
}

/**
 * Receipts for refunds the vault actually paid: a quorum slash's executed settlement (an open,
 * overturned or cancelled one paid nothing), or an older one-step slash. Each has `refund`.
 */
export function refundsOf(receipts: Receipt[]): Receipt[] {
  return receipts.filter((r) => (r.t === "slash" && !r.slashId) || (r.t === "settle" && r.outcome === "executed"));
}

/** Sums receipt amounts per asset, so HBAR and token payments are never added together. */
export function sumByAsset(receipts: Receipt[], field: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of receipts) {
    const asset = String(r.asset ?? "0.0.0");
    out.set(asset, (out.get(asset) ?? 0) + Number(r[field] ?? 0));
  }
  return out;
}

/** "0.026 ℏ · 0.0031 KUSD"; the current payment asset at zero when there is nothing yet. */
export function sumsText(status: Status, sums: Map<string, number>): string {
  const parts = [...sums].filter(([, v]) => v !== 0).map(([asset, v]) => amountOf(status, v, asset));
  return parts.length ? parts.join(" · ") : money(status, 0);
}

/** "0.5" in the payment asset → its smallest unit, as a string for the agent API. */
export const toUnits = (status: Status, value: string) => BigInt(Math.round(Number(value || 0) * 10 ** (status.payment?.decimals ?? 8))).toString();

/** Job ids embed their start time: job-<base36 ms>-<hex>. */
export function jobStartedAt(jobId: string): number | null {
  const t = parseInt(jobId.split("-")[1] ?? "", 36);
  return Number.isFinite(t) ? t : null;
}

/** A 0G Storage root: 0x and 64 hex. Older passports and listings hold other references. */
export const isStorageRef = (ref: string | undefined) => !!ref && /^0x[0-9a-f]{64}$/i.test(ref);

/** Public link to a document on 0G Storage (the indexer's /file?root=), or null when there isn't one. */
export function storageLink(status: Status, ref: string | undefined): string | null {
  if (REPLAY || !status.storageGateway || !isStorageRef(ref)) return null;
  return `${status.storageGateway.replace(/\/$/, "")}/file?root=${ref}`;
}

/** A stored passport by its 0G root, through the verifier, which checks the bytes against the root. */
export const getStoredPassport = <T,>(ref: string) => getJson<T>(`${VERIFIER_URL}/passports/${ref}`);

export function hashscan(status: Status, kind: "topic" | "transaction" | "contract" | "account" | "token", id: string): string | null {
  // Replay ids are invented; linking them would point at someone else's transaction.
  if (status.network !== "testnet" || REPLAY) return null;
  // Facilitator ids look like 0.0.x@seconds.nanos; HashScan wants 0.0.x-seconds-nanos.
  const at = id.indexOf("@");
  const normalized = kind === "transaction" && at > 0 ? `${id.slice(0, at)}-${id.slice(at + 1).replace(".", "-")}` : id;
  return `https://hashscan.io/testnet/${kind}/${normalized}`;
}

// Muted, distinguishable on near-black; red is left out so it only ever means "slashed".
const PALETTE = ["#7ad8c1", "#a9d4f5", "#d9a75e", "#c6a9f0", "#e6e6e9", "#8fb3a4", "#e0b4c8", "#9aa6ff"];
const assigned = new Map<string, string>();

/** Colour per provider, handed out in order of first sight so providers never share one. */
/** A GPU's state as the GPUs page reports it: slashed or rejected by the verifier, otherwise live while it has an offer. */
export function gpuState(snap: { reputations: Entity[]; status: Status }, addr: string): "live" | "rejected" | "slashed" {
  const rep = snap.reputations.find((r) => r.attrs.provider === addr && writtenBy(r, snap.status.verifier));
  return rep?.attrs.status === "slashed" ? "slashed" : rep?.attrs.qual_status === "rejected" ? "rejected" : "live";
}

export function providerColor(addr: string): string {
  let c = assigned.get(addr);
  if (!c) {
    c = PALETTE[assigned.size % PALETTE.length];
    assigned.set(addr, c);
  }
  return c;
}
