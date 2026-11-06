import { createPublicClient, createWalletClient, ExpirationTime, NoEntityFoundError, type ArkivValue, type Attributes, type EntityEvent as SdkEntityEvent, type Expression, type Schema } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, asc, desc, eq, gt, or } from "@arkiv-network/sdk/query";
import { addr, bytes, defineSchema, key, str, u64, type AnyColumn } from "@arkiv-network/sdk/schema";
import { defineChain, hexToString, http, isAddress, stringToHex, zeroAddress, type Chain, type Hex, type LocalAccount } from "viem";
import { ARKIV_NETWORKS, type NetworkConfig } from "../config.js";
import { signedPost } from "../util/sign.js";

// Arkiv holds KINETIC's shared, expiring coordination state:
//   offer       owner: provider   expires: OFFER_TTL, extended by heartbeat (dead nodes vanish)
//   claim       owner: buyer      expires: CLAIM_TTL (a lease; a dead provider's claim lapses)
//   job, chunk  owner: buyer      expires: JOB_TTL
//   reputation  owner: verifier   expires: REPUTATION_TTL, extended on every canary
//   check       owner: verifier   expires: CHECK_TTL; one per check, created readonly, never extended
//   model       owner: verifier   expires: MODEL_TTL, renewed by the verifier that listed it
// Every entity carries `app` and is written through the named schema `kinetic.<kind>`, whose
// indexed `arkiv.schema` tag says what it is. (Entities written before named schemas carry a
// `kind` attribute instead; reads match both, see kindFilter.)
//
// A provider's live record is the count of its unexpired `check` entities (pass = 1 or 0): a
// result older than CHECK_TTL drops out by itself, with no operator keeping a flag current.

export type EntityKind = "offer" | "claim" | "job" | "chunk" | "reputation" | "check" | "model";
export type AttrValue = string | number | bigint;
export type Attrs = Record<string, AttrValue>;

export const TTL = {
  offer: 90,
  claim: 2 * 60,
  job: 7 * 24 * 3600,
  reputation: 30 * 24 * 3600,
  check: 7 * 24 * 3600,
  model: 30 * 24 * 3600,
} as const;

export interface EntityInput {
  kind: EntityKind;
  attrs: Attrs;
  payload?: unknown;
  ttlSeconds: number;
  /**
   * Created with Arkiv's `readonly` flag: its attributes can never change again (it can still be
   * extended or deleted). For records written once, such as checks.
   */
  readonly?: boolean;
}

export interface StoredEntity {
  key: string;
  owner: string;
  /** The account that created it (`$creator`): unlike the owner, it never changes. */
  creator?: string;
  /** What the entity is, from its `arkiv.schema` tag (or, written before named schemas, its `kind`). */
  kind?: EntityKind;
  /** Written before named schemas: it carries a `kind` attribute and untyped (str/u64) values. */
  legacy?: boolean;
  /** Created with the `readonly` flag. */
  readonly?: boolean;
  attrs: Record<string, string | bigint>;
  payload: unknown;
  /** Block number (Arkiv) or unix ms (devnet). */
  expiresAt?: bigint;
  /** When it expires, as unix ms (estimated from blocks on Arkiv). */
  expiresAtMs?: number;
}

/** A server-side sort: a system field (`$expiresAt`, `$createdAt`, `$key`) or one of the kind's columns. */
export interface OrderBy {
  attr: string;
  desc?: boolean;
}

export interface QueryOptions {
  /** Only entities this account owns now (it can patch them). */
  owner?: string;
  /** Only entities this account created (`$creator` never changes, even if ownership is transferred). */
  creator?: string;
  limit?: number;
  /** Sorted by Arkiv. Without it, entities come in key order. */
  orderBy?: OrderBy;
}

/** A change to an entity on Arkiv. Arkiv emits no event when an entity expires. */
export interface StoreEvent {
  type: "created" | "patched" | "extended" | "transferred" | "deleted";
  key: string;
  /** The owner after the event (the new owner on a transfer). */
  owner: string;
  /** On created and extended. */
  expiresAtMs?: number;
  readonly?: boolean;
  /** The block it happened in (Arkiv only). */
  block?: bigint;
}

export interface WatchHandlers {
  onEvent: (e: StoreEvent) => void;
  /** The watcher was recreated and may have missed events: re-read what matters. */
  onGap?: (reason: string) => void;
  onError?: (err: Error) => void;
}

/** What this store has read from Arkiv. Only `arkiv_query` is metered (10 units each). */
export interface ReadStats {
  /** arkiv_query calls (query pages and counts): the metered reads. */
  queries: number;
  /** Units Arkiv reported spending on them (its `arkiv-cost` header), where it reports them. */
  units: number;
  /** getEntity calls (not metered). */
  gets: number;
  /** Entity events received. */
  events: number;
}

export interface ArkivStore {
  readonly owner: string;
  readonly app: string;
  /** Reads so far (see ReadStats). */
  readonly reads: ReadStats;
  create(input: EntityInput): Promise<string>;
  patch(key: string, attrs: Attrs, payload?: unknown): Promise<void>;
  extend(key: string, ttlSeconds: number): Promise<void>;
  remove(key: string): Promise<void>;
  query(kind: EntityKind, filter?: Attrs, opts?: QueryOptions): Promise<StoredEntity[]>;
  /** As query, plus how many entities match in all (counted by Arkiv, even past the limit). */
  queryCounted(kind: EntityKind, filter?: Attrs, opts?: QueryOptions): Promise<{ entities: StoredEntity[]; total: number }>;
  /** How many entities match, counted by Arkiv without reading them. */
  count(kind: EntityKind, filter?: Attrs, opts?: Omit<QueryOptions, "limit" | "orderBy">): Promise<number>;
  /** One entity by key (unmetered on Arkiv), or null once it is deleted or expired. Any app's. */
  get(key: string): Promise<StoredEntity | null>;
  /** Live entity events, for every entity on the network. Returns a function that stops watching. */
  watch(handlers: WatchHandlers): () => void;
  /** Resolves once every queued write has landed. */
  flush(): Promise<void>;
}

// ── Arkiv's data model (SDK 1.0, Rabdi) ──────────────────────────────────────
// An entity is only typed attributes: there is no separate payload. KINETIC's JSON payload is an
// unindexed `bytes` attribute named `payload` (UTF-8 JSON, up to 128 KiB).
//
// Each kind is written through a named schema, `kinetic.<kind>`, which adds the indexed
// `arkiv.schema` tag (so 31 attributes are left, as `kind` used one before). Its columns are typed
// (`addr` for EVM addresses, `key` for links to other entities, `u64` for amounts in base units
// and counts, `str` otherwise) and only the ones KINETIC filters on are indexed. The columns an
// entity carries still vary (an offer has one `model.<key>` per model it serves), so each write
// names a schema of exactly the columns it carries, typed by the table below.

/** The attribute that holds an entity's JSON payload. Never returned among `attrs`. */
export const PAYLOAD_ATTR = "payload";

/** The tag a named schema writes (the SDK's SCHEMA_ATTRIBUTE). */
export const SCHEMA_ATTR = "arkiv.schema";

/** The named schema a kind is written through. */
export const schemaName = (kind: EntityKind) => `kinetic.${kind}`;

const KINDS: readonly EntityKind[] = ["offer", "claim", "job", "chunk", "reputation", "check", "model"];

/** The kind an entity's attributes say it is: its schema tag, or a legacy `kind` attribute. */
export function kindOfAttrs(attrs: Record<string, unknown>): { kind?: EntityKind; legacy: boolean } {
  const tag = attrs[SCHEMA_ATTR];
  if (typeof tag === "string" && tag.startsWith("kinetic.")) {
    const kind = tag.slice("kinetic.".length) as EntityKind;
    if (KINDS.includes(kind)) return { kind, legacy: false };
  }
  const legacy = attrs.kind;
  if (typeof legacy === "string" && KINDS.includes(legacy as EntityKind)) return { kind: legacy as EntityKind, legacy: true };
  return { legacy: false };
}

export type ColumnType = "str" | "u64" | "addr" | "key";
export interface ColumnSpec {
  type: ColumnType;
  indexed: boolean;
}
const col = (type: ColumnType, indexed = false): ColumnSpec => ({ type, indexed });

/**
 * The columns of each kind. Indexed: what KINETIC (and the queries in arkiv/schema.md) filter on.
 * Everything else is stored and can be sorted on, but not filtered. An attribute not listed here
 * (a new one) is indexed, typed by its value, as every attribute was before.
 */
export const COLUMNS: Record<EntityKind, Record<string, ColumnSpec>> = {
  offer: {
    app: col("str", true),
    provider: col("addr", true),
    pay_to: col("str"),
    name: col("str"),
    endpoint: col("str"),
    gpu: col("str"),
    price: col("u64", true),
    bond: col("u64"),
    uaid: col("str", true),
    adversarial: col("str"),
    zg_provider: col("addr"),
    hcs10_inbound: col("str"),
    sandbox: col("str"),
    erc8004: col("u64"),
  },
  claim: { app: col("str", true), job_id: col("str", true), idx: col("u64"), provider: col("addr") },
  job: {
    app: col("str", true),
    job_id: col("str", true),
    task: col("str"),
    status: col("str"),
    total: col("u64"),
    done: col("u64"),
    rerouted: col("u64"),
    paid: col("u64"),
    refunded: col("u64"),
    fee: col("u64"),
    royalty: col("u64"),
    audit_ref: col("str"),
    model: col("str"),
  },
  chunk: { app: col("str", true), job_id: col("str", true), job_key: col("key", true), idx: col("u64"), status: col("str"), provider: col("addr") },
  reputation: {
    app: col("str", true),
    provider: col("addr", true),
    status: col("str", true),
    pass: col("u64"),
    fail: col("u64"),
    score: col("u64"),
    window: col("str"),
    latency_ms: col("u64"),
    name: col("str"),
    gpu: col("str"),
    adversarial: col("str"),
    uaid: col("str"),
    qual_status: col("str"),
    qual_agreement: col("u64"),
    fp_status: col("str"),
    fp_match: col("u64"),
    fp_model: col("str"),
    fp_closest: col("str"),
  },
  check: { app: col("str", true), provider: col("addr", true), pass: col("u64", true), src: col("str"), at: col("u64"), job_id: col("str"), idx: col("u64") },
  model: {
    app: col("str", true),
    mkey: col("str", true),
    model_id: col("str", true),
    version: col("str", true),
    status: col("str", true),
    name: col("str"),
    creator: col("str"),
    royalty_bps: col("u64"),
    accuracy: col("u64"),
    engine: col("str"),
    passport_ref: col("str"),
    passport_digest: col("str"),
  },
};

/** Families of attributes named per entry: `task.<kind>` = 1, `model.<key>` = 1. Filtered on. */
const PREFIX_COLUMNS: [string, ColumnSpec][] = [
  ["task.", col("u64", true)],
  ["model.", col("u64", true)],
];

/** An attribute's column; kind unknown (a patch of an entity this store never read): every name's usual type, indexed. */
export function columnOf(kind: EntityKind | undefined, name: string): ColumnSpec | undefined {
  if (kind) {
    const spec = COLUMNS[kind][name];
    if (spec) return spec;
  } else {
    for (const k of KINDS) {
      const spec = COLUMNS[k][name];
      if (spec) return { type: spec.type, indexed: true };
    }
  }
  for (const [prefix, spec] of PREFIX_COLUMNS) if (name.startsWith(prefix)) return spec;
  return undefined;
}

/** Throws unless every attribute in a filter is indexed for that kind: Arkiv can only filter on those. */
export function assertFilterable(kind: EntityKind, filter: Attrs): void {
  for (const name of Object.keys(filter)) {
    const spec = columnOf(kind, name);
    if (spec && !spec.indexed) throw new Error(`Arkiv ${kind}.${name} is not indexed, so it can't be filtered on (see COLUMNS in src/integrations/arkiv.ts)`);
  }
}

const KEY_RE = /^0x[0-9a-f]{64}$/;

/** A value as its column's type. A string that isn't a valid address or key stays a str. */
function typedValue(spec: ColumnSpec | undefined, v: AttrValue): ArkivValue {
  if (typeof v !== "string") return u64(BigInt(v));
  if (spec?.type === "addr") {
    const s = v.toLowerCase();
    // An address not yet known (a pending chunk's provider) is the zero address, read back as "".
    if (s === "") return addr(zeroAddress);
    if (isAddress(s, { strict: false })) return addr(s);
  }
  if (spec?.type === "key" && KEY_RE.test(v.toLowerCase())) return key(v.toLowerCase() as Hex);
  return str(v);
}

/** As entities were written before typed columns: str or u64. */
const untypedValue = (v: AttrValue): ArkivValue => (typeof v === "string" ? str(v) : u64(BigInt(v)));

function columnFor(value: ArkivValue, indexed: boolean): AnyColumn {
  if (value.type === "bytes") return bytes();
  const c = value.type === "addr" ? addr() : value.type === "key" ? key() : value.type === "u64" ? u64() : str();
  return indexed ? c.indexed() : c;
}

/** The schema and values of one write: named for a create, unnamed (columns only) for a patch. */
function writeOf(kind: EntityKind | undefined, attrs: Attrs, payload: unknown, named: boolean): { schema: Schema; values: Record<string, ArkivValue> } {
  const columns: Record<string, AnyColumn> = {};
  const values: Record<string, ArkivValue> = {};
  for (const [name, v] of Object.entries(attrs)) {
    const spec = columnOf(kind, name);
    const value = typedValue(spec, v);
    values[name] = value;
    columns[name] = columnFor(value, spec?.indexed ?? true);
  }
  if (payload !== undefined) {
    values[PAYLOAD_ATTR] = bytes(stringToHex(JSON.stringify(payload)));
    columns[PAYLOAD_ATTR] = bytes();
  }
  return { schema: named && kind ? defineSchema(schemaName(kind), columns) : defineSchema(columns), values };
}

/**
 * Entities of one kind and app matching a filter: written through the kind's named schema (typed
 * values), or before it, with a `kind` attribute (untyped values). Legacy entities expire within
 * their TTL (reputation is re-created on its next write), after which the second branch matches nothing.
 */
function kindFilter(app: string, kind: EntityKind, filter: Attrs): Expression {
  const current = [eq(SCHEMA_ATTR, str(schemaName(kind))), eq("app", str(app)), ...Object.entries(filter).map(([k, v]) => eq(k, typedValue(columnOf(kind, k), v) as never))];
  const legacy = [eq("kind", str(kind)), eq("app", str(app)), ...Object.entries(filter).map(([k, v]) => eq(k, untypedValue(v) as never))];
  return or(and(current), and(legacy));
}

/** Arkiv counts lifetimes in 2-second blocks. */
const BLOCK_SECONDS = 2;

/** A TTL as an Arkiv lifetime, rounded up to whole blocks. */
const lifetime = (ttlSeconds: number) => ExpirationTime.fromBlocks(Math.max(1, Math.ceil(ttlSeconds / BLOCK_SECONDS)));

/** An entity's attributes as KINETIC reads them: u64 as bigint, addresses and keys lower-case, no payload or tag. */
function fromSdkAttrs(attributes: Attributes): Record<string, string | bigint> {
  const out: Record<string, string | bigint> = {};
  for (const [k, v] of Object.entries(attributes)) {
    if (k === PAYLOAD_ATTR || k === SCHEMA_ATTR) continue;
    if (v.type === "addr") out[k] = v.value.toLowerCase() === zeroAddress ? "" : v.value.toLowerCase();
    else if (v.type === "key") out[k] = v.value.toLowerCase();
    else out[k] = typeof v.value === "bigint" ? v.value : typeof v.value === "number" ? BigInt(v.value) : String(v.value);
  }
  return out;
}

/** The JSON payload, or null when there is none or it isn't JSON (anyone can write a matching entity). */
function payloadOf(attributes: Attributes): unknown {
  const v = attributes[PAYLOAD_ATTR];
  if (!v || (v.type !== "bytes" && v.type !== "str")) return null;
  try {
    return JSON.parse(v.type === "bytes" ? hexToString(v.value) : v.value);
  } catch {
    return null;
  }
}

function tagOf(attributes: Attributes): Record<string, unknown> {
  return { [SCHEMA_ATTR]: attributes[SCHEMA_ATTR]?.value, kind: attributes.kind?.value };
}

// ── Arkiv testnet (SDK) ──────────────────────────────────────────────────────

type Op =
  | { type: "create"; input: EntityInput; resolve: (key: string) => void; reject: (e: unknown) => void }
  | { type: "patch"; key: string; attrs: Attrs; payload?: unknown; resolve: () => void; reject: (e: unknown) => void }
  | { type: "extend"; key: string; ttlSeconds: number; resolve: () => void; reject: (e: unknown) => void }
  | { type: "remove"; key: string; resolve: () => void; reject: (e: unknown) => void };

const MAX_OPS_PER_TX = 40;

/** The most entities one query page returns (the node's maximum). */
const PAGE_SIZE = 100;

/** How long to stop sending an access key after Arkiv says its quota is used up. */
const QUOTA_BACKOFF_MS = 10 * 60_000;

/** The longest Retry-After worth waiting for; Arkiv's budget resets are many minutes away. */
const MAX_RETRY_AFTER_S = 30;

/** Watcher supervision (see watch): how far behind it may fall, and what counts as a stall. */
const WATCH_MAX_LAG_BLOCKS = 900n;
const WATCH_CHECK_MS = 30_000;
const WATCH_STALL_MS = 90_000;
const WATCH_ERRORS_BEFORE_RESTART = 3;

/**
 * Arkiv answers 429 with a Retry-After of many minutes once a query budget is spent, and viem
 * waits that long before each retry: a query would hang for most of an hour. This drops such a
 * Retry-After, so the call fails in seconds with Arkiv's reason, and callers carry on.
 */
function failFast(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const res = await inner(input, init);
    const wait = Number(res.headers.get("retry-after"));
    if (res.status !== 429 || !(wait > MAX_RETRY_AFTER_S)) return res;
    const headers = new Headers(res.headers);
    headers.delete("retry-after");
    return new Response(await res.text(), { status: res.status, statusText: res.statusText, headers });
  };
}

/** Counts metered reads: Arkiv reports what each request cost in its `arkiv-cost` header. */
function metered(inner: typeof fetch, stats: ReadStats): typeof fetch {
  return async (input, init) => {
    const res = await inner(input, init);
    const cost = Number(res.headers.get("arkiv-cost"));
    if (cost > 0) stats.units += cost;
    return res;
  };
}

/**
 * Fetch for Arkiv's RPC with an access key (X-API-KEY), which lifts the anonymous per-IP rate
 * limit but spends the key's quota. When the quota runs out Arkiv answers 429 QUOTA_EXCEEDED;
 * the request is then sent again without the key (the anonymous limit still applies), and the
 * key rests for a while so every call doesn't pay for a refusal first.
 */
function keyedFetch(apiKey: string): typeof fetch {
  let restUntil = 0;
  return async (input, init) => {
    const anonymous = () => fetch(input, init);
    if (Date.now() < restUntil) return anonymous();
    const headers = new Headers(init?.headers);
    headers.set("X-API-KEY", apiKey);
    const res = await fetch(input, { ...init, headers });
    if (res.status !== 429 || !(await res.clone().text()).includes("QUOTA_EXCEEDED")) return res;
    if (Date.now() >= restUntil) console.warn(`Arkiv access key quota used up; reading anonymously for ${QUOTA_BACKOFF_MS / 60_000} minutes`);
    restUntil = Date.now() + QUOTA_BACKOFF_MS;
    return anonymous();
  };
}

const SELECT = { $key: true, $owner: true, $creator: true, $expiresAt: true, $creationFlags: true, $attributes: true } as const;

export class ArkivSdkStore implements ArkivStore {
  readonly owner: string;
  readonly reads: ReadStats = { queries: 0, units: 0, gets: 0, events: 0 };
  private readonly wallet;
  private readonly reader;
  private queue: Op[] = [];
  private draining: Promise<void> | null = null;
  /** The kind of entities this store wrote or read, so a patch types and indexes its columns right. */
  private readonly kinds = new Map<string, EntityKind>();
  /** The latest block seen, to turn block expiries into wall-clock times. */
  private head?: { block: bigint; at: number };

  constructor(
    account: LocalAccount,
    cfg: NetworkConfig["arkiv"],
    readonly app = process.env.ARKIV_APP || "kinetic",
  ) {
    this.owner = account.address.toLowerCase();
    const chain = arkivChain(cfg);
    // Bounded retries and timeout: when Arkiv rate-limits, calls fail in seconds instead of hanging.
    const transport = http(cfg.rpcUrl, { timeout: 15_000, retryCount: 2, fetchFn: failFast(metered(cfg.apiKey ? keyedFetch(cfg.apiKey) : fetch, this.reads)) });
    this.wallet = createWalletClient({ account, chain, transport });
    this.reader = createPublicClient({ chain, transport });
  }

  create(input: EntityInput): Promise<string> {
    return new Promise((resolve, reject) => this.enqueue({ type: "create", input, resolve, reject }));
  }

  patch(key: string, attrs: Attrs, payload?: unknown): Promise<void> {
    return new Promise((resolve, reject) => this.enqueue({ type: "patch", key, attrs, payload, resolve, reject }));
  }

  extend(key: string, ttlSeconds: number): Promise<void> {
    return new Promise((resolve, reject) => this.enqueue({ type: "extend", key, ttlSeconds, resolve, reject }));
  }

  remove(key: string): Promise<void> {
    return new Promise((resolve, reject) => this.enqueue({ type: "remove", key, resolve, reject }));
  }

  async flush(): Promise<void> {
    while (this.draining) await this.draining;
  }

  async query(kind: EntityKind, filter: Attrs = {}, opts: QueryOptions = {}): Promise<StoredEntity[]> {
    return (await this.scan(kind, filter, opts, false)).entities;
  }

  queryCounted(kind: EntityKind, filter: Attrs = {}, opts: QueryOptions = {}): Promise<{ entities: StoredEntity[]; total: number }> {
    return this.scan(kind, filter, opts, true);
  }

  async count(kind: EntityKind, filter: Attrs = {}, opts: Omit<QueryOptions, "limit" | "orderBy"> = {}): Promise<number> {
    assertFilterable(kind, filter);
    let builder = this.reader.count().where(kindFilter(this.app, kind, filter));
    if (opts.owner) builder = builder.ownedBy(opts.owner as Hex);
    if (opts.creator) builder = builder.createdBy(opts.creator as Hex);
    this.reads.queries += 1;
    return Number(await builder.fetch());
  }

  async get(entityKey: string): Promise<StoredEntity | null> {
    this.reads.gets += 1;
    try {
      const e = await this.reader.getEntity(entityKey as Hex);
      if (!this.head) this.noteHead(await this.reader.getBlockNumber());
      return this.toStored(e, this.estimatedHead());
    } catch (err) {
      if (err instanceof NoEntityFoundError) return null;
      throw err;
    }
  }

  /**
   * Arkiv's entity events (`watchEntityEvents`), supervised: the watcher is recreated when it keeps
   * failing, when the process stalled (a sleeping laptop), or when it has been ~1,000 blocks
   * without an event (the node drops a filter that falls that far behind). Each recreation may have
   * missed events, so it is reported through onGap.
   */
  watch(h: WatchHandlers): () => void {
    let unwatch: (() => void) | null = null;
    let stopped = false;
    let restarting = false;
    let backoff = 2000;
    let errors = 0;
    let lastEventBlock: bigint | undefined;
    let lastCheck = Date.now();
    const start = () => {
      errors = 0;
      unwatch = this.reader.watchEntityEvents({
        onEvent: (e) => {
          errors = 0;
          backoff = 2000;
          lastEventBlock = e.blockNumber;
          this.reads.events += 1;
          h.onEvent(this.toEvent(e));
        },
        onError: (err) => {
          h.onError?.(err);
          if (++errors >= WATCH_ERRORS_BEFORE_RESTART) restart(`watcher failing: ${err.message.split("\n")[0]!.slice(0, 120)}`);
        },
      });
    };
    const restart = (reason: string) => {
      if (restarting || stopped) return;
      restarting = true;
      unwatch?.();
      unwatch = null;
      const wait = backoff;
      backoff = Math.min(backoff * 2, 60_000);
      setTimeout(() => {
        restarting = false;
        if (stopped) return;
        lastEventBlock = undefined;
        start();
        h.onGap?.(reason);
      }, wait).unref?.();
    };
    const timer = setInterval(() => {
      const now = Date.now();
      const stalled = now - lastCheck > WATCH_STALL_MS;
      lastCheck = now;
      if (stalled) return restart("the process stalled");
      this.reader
        .getBlockNumber()
        .then((head) => {
          this.noteHead(head);
          if (lastEventBlock === undefined) lastEventBlock = head;
          else if (head - lastEventBlock > WATCH_MAX_LAG_BLOCKS) restart(`no events for ${head - lastEventBlock} blocks`);
        })
        .catch(() => undefined);
    }, WATCH_CHECK_MS);
    timer.unref?.();
    start();
    return () => {
      stopped = true;
      clearInterval(timer);
      unwatch?.();
      unwatch = null;
    };
  }

  private toEvent(e: SdkEntityEvent): StoreEvent {
    this.noteHead(e.blockNumber);
    const base = { key: e.entityKey.toLowerCase(), block: e.blockNumber };
    switch (e.type) {
      case "EntityCreated":
        return { ...base, type: "created", owner: e.owner.toLowerCase(), expiresAtMs: this.msAt(e.expiresAt, e.blockNumber), readonly: e.creationFlags.readonly };
      case "EntityPatched":
        return { ...base, type: "patched", owner: e.owner.toLowerCase() };
      case "ExpiryExtended":
        return { ...base, type: "extended", owner: e.owner.toLowerCase(), expiresAtMs: this.msAt(e.expiresAt, e.blockNumber) };
      case "OwnershipTransferred":
        return { ...base, type: "transferred", owner: e.newOwner.toLowerCase() };
      case "EntityDeleted":
        return { ...base, type: "deleted", owner: e.owner.toLowerCase() };
    }
  }

  private noteHead(block: bigint): void {
    if (!this.head || block > this.head.block) this.head = { block, at: Date.now() };
  }

  private estimatedHead(): bigint | undefined {
    if (!this.head) return undefined;
    return this.head.block + BigInt(Math.floor((Date.now() - this.head.at) / (BLOCK_SECONDS * 1000)));
  }

  /** An expiry block as unix ms, given the block it was read at. */
  private msAt(expiresAt: bigint, atBlock: bigint | undefined): number | undefined {
    if (atBlock === undefined) return undefined;
    return Date.now() + Number(expiresAt - atBlock) * BLOCK_SECONDS * 1000;
  }

  private toStored(
    e: { $key: Hex; $owner: Hex; $creator?: Hex; $expiresAt: bigint; $creationFlags?: { readonly: boolean }; $attributes: Attributes },
    atBlock: bigint | undefined,
  ): StoredEntity {
    const { kind, legacy } = kindOfAttrs(tagOf(e.$attributes));
    if (kind) this.rememberKind(e.$key, kind);
    return {
      key: e.$key,
      owner: e.$owner.toLowerCase(),
      ...(e.$creator ? { creator: e.$creator.toLowerCase() } : {}),
      ...(kind ? { kind } : {}),
      ...(legacy ? { legacy } : {}),
      ...(e.$creationFlags?.readonly ? { readonly: true } : {}),
      attrs: fromSdkAttrs(e.$attributes),
      payload: payloadOf(e.$attributes),
      expiresAt: e.$expiresAt,
      ...(atBlock !== undefined ? { expiresAtMs: this.msAt(e.$expiresAt, atBlock) } : {}),
    };
  }

  private rememberKind(entityKey: string, kind: EntityKind): void {
    const k = entityKey.toLowerCase();
    if (this.kinds.has(k)) return;
    if (this.kinds.size >= 20_000) this.kinds.delete(this.kinds.keys().next().value!);
    this.kinds.set(k, kind);
  }

  private async scan(kind: EntityKind, filter: Attrs, opts: QueryOptions, counted: boolean): Promise<{ entities: StoredEntity[]; total: number }> {
    assertFilterable(kind, filter);
    const match = kindFilter(this.app, kind, filter);
    const limit = opts.limit ?? 1000;
    const out: StoredEntity[] = [];
    let total = 0;
    // Pages of at most 100 (the node's cap). In key order they are keyed on $key, so a write between
    // pages can't shift them; a server sort pages by offset (for top-N reads, which fit in a page).
    let after: Hex | undefined;
    for (let pageNo = 0; out.length < limit; pageNo++) {
      const size = Math.min(PAGE_SIZE, limit - out.length);
      let builder = this.reader
        .select(SELECT)
        .where(after ? and(match, gt("$key", key(after))) : match)
        .limit(size);
      if (opts.orderBy) {
        const { attr, desc: down } = opts.orderBy;
        const type = attr.startsWith("$") ? undefined : (columnOf(kind, attr)?.type ?? "str");
        const term = type ? (down ? desc(attr, type) : asc(attr, type)) : down ? desc(attr) : asc(attr);
        builder = builder.orderBy(term as never).offset(pageNo * PAGE_SIZE);
      } else builder = builder.orderBy(asc("$key"));
      if (opts.owner) builder = builder.ownedBy(opts.owner as Hex);
      if (opts.creator) builder = builder.createdBy(opts.creator as Hex);
      this.reads.queries += 1;
      const page = pageNo === 0 && counted ? await builder.withCount().fetch() : await builder.fetch();
      if (pageNo === 0 && counted) total = Number((page as { count?: bigint }).count ?? 0n);
      this.noteHead(page.blockNumber);
      for (const e of page.entities) out.push(this.toStored(e, page.blockNumber));
      if (page.entities.length < size) break;
      if (!opts.orderBy) after = page.entities[page.entities.length - 1]!.$key;
    }
    return { entities: out, total: counted ? Math.max(total, out.length) : out.length };
  }

  private enqueue(op: Op): void {
    this.queue.push(op);
    this.kick();
  }

  // A write can be queued after drain() has seen an empty queue but before `draining` is
  // cleared (the resolve of one write schedules the next one). Re-check on the way out so
  // that write is never stranded.
  private kick(): void {
    if (this.draining) return;
    this.draining = this.drain().finally(() => {
      this.draining = null;
      if (this.queue.length > 0) this.kick();
    });
  }

  // Coalesces queued writes into as few transactions as possible. One wallet means one
  // nonce sequence, so all writes go through this single loop.
  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch: Op[] = [];
      const deferred: Op[] = [];
      const touched = new Map<string, Op>();
      for (const op of this.queue) {
        if (batch.length >= MAX_OPS_PER_TX) {
          deferred.push(op);
          continue;
        }
        if (op.type === "create") {
          batch.push(op);
          continue;
        }
        const prior = touched.get(op.key);
        if (!prior) {
          touched.set(op.key, op);
          batch.push(op);
        } else if (prior.type === "patch" && op.type === "patch") {
          prior.attrs = { ...prior.attrs, ...op.attrs };
          if (op.payload !== undefined) prior.payload = op.payload;
          const first = prior.resolve;
          const firstReject = prior.reject;
          prior.resolve = () => (first(), op.resolve());
          prior.reject = (e) => (firstReject(e), op.reject(e));
        } else {
          deferred.push(op);
        }
      }
      this.queue = deferred;

      const creates = batch.filter((o): o is Extract<Op, { type: "create" }> => o.type === "create");
      const allPatches = batch.filter((o): o is Extract<Op, { type: "patch" }> => o.type === "patch");
      // A patch that changes nothing is done already (the engine refuses an empty one).
      const patches = allPatches.filter((p) => Object.keys(p.attrs).length > 0 || p.payload !== undefined);
      const extensions = batch.filter((o): o is Extract<Op, { type: "extend" }> => o.type === "extend");
      const deletes = batch.filter((o): o is Extract<Op, { type: "remove" }> => o.type === "remove");
      try {
        const sent = creates.length + patches.length + extensions.length + deletes.length > 0;
        const result = sent
          ? await this.wallet.executeBatch({
              creates: creates.map(({ input }) => ({
                ...writeOf(input.kind, { app: this.app, ...input.attrs }, input.payload ?? {}, true),
                expiration: lifetime(input.ttlSeconds),
                ...(input.readonly ? { flags: { readonly: true } } : {}),
              })),
              patches: patches.map((p) => {
                const { schema, values } = writeOf(this.kinds.get(p.key.toLowerCase()), p.attrs, p.payload, false);
                return { schema, entityKey: p.key as Hex, set: values };
              }),
              // An extension sets the expiry to ttl from now (as the devnet does); Arkiv refuses one
              // that would move it earlier, and every caller extends by the TTL it created with.
              extensions: extensions.map((e) => ({ entityKey: e.key as Hex, expiration: lifetime(e.ttlSeconds) })),
              deletes: deletes.map((d) => ({ entityKey: d.key as Hex })),
            })
          : { createdEntities: [] as Hex[] };
        creates.forEach((c, i) => {
          const created = result.createdEntities[i];
          if (created) this.rememberKind(created, c.input.kind);
          c.resolve(created);
        });
        for (const op of [...allPatches, ...extensions, ...deletes]) op.resolve();
      } catch (err) {
        for (const op of batch) op.reject(err);
      }
    }
  }
}

/**
 * The configured Arkiv network as a viem chain, with cfg.rpcUrl as its RPC. Rabdi is the SDK's
 * own chain; its access key travels as X-API-KEY (see keyedFetch), never in the URL, so the key can
 * be dropped when its quota runs out. Any other chain id gets the same shape under its own id.
 */
export function arkivChain(cfg: Pick<NetworkConfig["arkiv"], "rpcUrl" | "chainId"> & Partial<Pick<NetworkConfig["arkiv"], "apiKey" | "explorerUrl">>): Chain {
  const rpcUrls = { default: { http: [cfg.rpcUrl] } };
  if (cfg.chainId === ARKIV_NETWORKS.rabdi.chainId) return { ...rabdi({ accessKey: cfg.apiKey ?? "" }), rpcUrls };
  return defineChain({
    id: cfg.chainId,
    name: "Arkiv",
    nativeCurrency: { name: "Golem", symbol: "tGLM", decimals: 18 },
    rpcUrls,
    ...(cfg.explorerUrl ? { blockExplorers: { default: { name: "Arkiv Explorer", url: cfg.explorerUrl } } } : {}),
    testnet: true,
  });
}

// ── Devnet ───────────────────────────────────────────────────────────────────

/** JSON-safe attribute encoding that keeps Arkiv's str/u64 distinction. */
export type WireAttr = string | { u64: string };

export function encodeAttrs(attrs: Attrs): Record<string, WireAttr> {
  return Object.fromEntries(
    Object.entries(attrs).map(([k, v]) => [k, typeof v === "string" ? v : { u64: BigInt(v).toString() }]),
  );
}

export function decodeAttrs(attrs: Record<string, WireAttr>): Record<string, string | bigint> {
  return Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, typeof v === "string" ? v : BigInt(v.u64)]));
}

/** An entity as the devnet emulator sends it. */
interface WireEntity {
  key: string;
  owner: string;
  creator?: string;
  readonly?: boolean;
  attrs: Record<string, WireAttr>;
  payload: unknown;
  expiresAt?: number;
}

/** Devnet entity events, as the emulator logs them. */
interface WireEvent {
  seq: number;
  type: StoreEvent["type"];
  key: string;
  owner: string;
  expiresAt?: number;
  readonly?: boolean;
}

export class ArkivDevnetStore implements ArkivStore {
  readonly owner: string;
  readonly reads: ReadStats = { queries: 0, units: 0, gets: 0, events: 0 };

  constructor(
    private readonly account: LocalAccount,
    private readonly devnetUrl: string,
    readonly app = process.env.ARKIV_APP || "kinetic",
  ) {
    this.owner = account.address.toLowerCase();
  }

  private async call<T>(op: string, body: unknown): Promise<T> {
    const res = await signedPost(this.account, `${this.devnetUrl}/arkiv/${op}`, body);
    if (!res.ok) throw new Error(`arkiv ${op} failed (${res.status}): ${await res.text()}`);
    return (await res.json()) as T;
  }

  private async post<T>(op: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.devnetUrl}/arkiv/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`arkiv ${op} failed (${res.status}): ${await res.text()}`);
    return (await res.json()) as T;
  }

  async create(input: EntityInput): Promise<string> {
    // As on Arkiv: the schema tag in place of `kind`.
    const { key } = await this.call<{ key: string }>("create", {
      attrs: encodeAttrs({ [SCHEMA_ATTR]: schemaName(input.kind), app: this.app, ...input.attrs }),
      payload: input.payload ?? {},
      ttlSeconds: input.ttlSeconds,
      ...(input.readonly ? { readonly: true } : {}),
    });
    return key;
  }

  async patch(key: string, attrs: Attrs, payload?: unknown): Promise<void> {
    await this.call("patch", { key, attrs: encodeAttrs(attrs), payload });
  }

  async extend(key: string, ttlSeconds: number): Promise<void> {
    await this.call("extend", { key, ttlSeconds });
  }

  async remove(key: string): Promise<void> {
    await this.call("delete", { key });
  }

  private where(kind: EntityKind, filter: Attrs, opts: QueryOptions) {
    assertFilterable(kind, filter);
    return {
      where: encodeAttrs({ app: this.app, ...filter }),
      // The named schema's tag, or (written before it) a `kind` attribute.
      or: [{ [SCHEMA_ATTR]: schemaName(kind) }, { kind }],
      owner: opts.owner,
      creator: opts.creator,
    };
  }

  async query(kind: EntityKind, filter: Attrs = {}, opts: QueryOptions = {}): Promise<StoredEntity[]> {
    return (await this.queryCounted(kind, filter, opts)).entities;
  }

  async queryCounted(kind: EntityKind, filter: Attrs = {}, opts: QueryOptions = {}): Promise<{ entities: StoredEntity[]; total: number }> {
    this.reads.queries += 1;
    const { entities, total } = await this.post<{ entities: WireEntity[]; total: number }>("query", { ...this.where(kind, filter, opts), limit: opts.limit, orderBy: opts.orderBy });
    return { entities: entities.map(fromWire), total };
  }

  async count(kind: EntityKind, filter: Attrs = {}, opts: Omit<QueryOptions, "limit" | "orderBy"> = {}): Promise<number> {
    this.reads.queries += 1;
    return (await this.post<{ total: number }>("query", { ...this.where(kind, filter, opts), limit: 0 })).total;
  }

  async get(key: string): Promise<StoredEntity | null> {
    this.reads.gets += 1;
    const { entity } = await this.post<{ entity: WireEntity | null }>("get", { key });
    return entity ? fromWire(entity) : null;
  }

  /** The emulator's event log, polled (Arkiv's watcher polls too, every half block). */
  watch(h: WatchHandlers): () => void {
    let stopped = false;
    let after: number | undefined;
    const poll = async () => {
      while (!stopped) {
        try {
          const res = await fetch(`${this.devnetUrl}/arkiv/events?after=${after ?? -1}`);
          const { events, seq } = (await res.json()) as { events: WireEvent[]; seq: number };
          // The first poll starts at the head, like Arkiv's watcher; a reset emulator is a gap.
          if (after !== undefined && seq < after) h.onGap?.("the devnet restarted");
          if (after !== undefined) {
            for (const e of events) {
              this.reads.events += 1;
              h.onEvent({ type: e.type, key: e.key.toLowerCase(), owner: e.owner, ...(e.expiresAt !== undefined ? { expiresAtMs: e.expiresAt } : {}), ...(e.readonly ? { readonly: true } : {}) });
            }
          }
          after = seq;
        } catch (err) {
          if (!stopped) h.onError?.(err as Error);
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    void poll();
    return () => {
      stopped = true;
    };
  }

  async flush(): Promise<void> {}
}

function fromWire(e: WireEntity): StoredEntity {
  const attrs = decodeAttrs(e.attrs);
  const { kind, legacy } = kindOfAttrs(attrs);
  delete attrs[SCHEMA_ATTR];
  return {
    key: e.key,
    owner: e.owner,
    ...(e.creator ? { creator: e.creator } : {}),
    ...(kind ? { kind } : {}),
    ...(legacy ? { legacy } : {}),
    ...(e.readonly ? { readonly: true } : {}),
    attrs,
    payload: e.payload,
    expiresAt: e.expiresAt === undefined ? undefined : BigInt(e.expiresAt),
    ...(e.expiresAt !== undefined ? { expiresAtMs: e.expiresAt } : {}),
  };
}

export function attrBig(e: StoredEntity, name: string): bigint {
  const v = e.attrs[name];
  return v === undefined ? 0n : BigInt(v);
}

export function attrStr(e: StoredEntity, name: string): string {
  const v = e.attrs[name];
  return v === undefined ? "" : String(v);
}
