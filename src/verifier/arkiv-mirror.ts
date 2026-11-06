import type { ArkivStore, EntityKind, OrderBy, ReadStats, StoredEntity, StoreEvent } from "../integrations/arkiv.js";

// A live copy of KINETIC's Arkiv entities, for the dashboard proxy (GET /arkiv/:kind and the
// Server-Sent Events stream GET /arkiv/events).
//
// It used to re-query every kind every few seconds while a dashboard was open; each query page is a
// metered `arkiv_query`. Now Arkiv's entity events keep it current: an event names an entity, which
// is re-read with getEntity (not metered), and deletions and extensions need no read at all.
// Arkiv emits no event on expiry, so expired entities are swept by their expiry time, and every
// kind is still fully re-read every few minutes to correct anything an event missed. It runs only
// while someone is reading, and stops after IDLE_MS without a request or subscriber.

/** An entity as the dashboard reads it (numbers rather than bigints). */
export interface MirrorEntity {
  key: string;
  owner: string;
  creator?: string;
  readonly?: boolean;
  attrs: Record<string, string | number>;
  payload: unknown;
  expiresAtMs?: number;
}

export interface MirrorChange {
  kind: EntityKind;
  upserts: MirrorEntity[];
  removes: string[];
}

export interface MirrorSnapshot {
  kind: EntityKind;
  at: number;
  /** How many match on Arkiv, counted by Arkiv (entities is capped at the read limit). */
  count: number;
  /** Kept current from events (false: read by polling while the watcher is down). */
  live: boolean;
  entities: MirrorEntity[];
}

export interface MirrorOptions {
  kinds: EntityKind[];
  /** Full re-read of each kind (default 3 min). */
  reconcileMs?: number;
  /** The old polling cadence per kind, used while the watcher is failing and to estimate reads saved. */
  pollMs: Partial<Record<EntityKind, number>>;
  /** Stop after this long with no reader (default 10 min). */
  idleMs?: number;
  /** Entities read per kind (default 2000). */
  limit?: number;
  /** Kinds Arkiv sorts on a full read (small ones: it pages a sort by offset); events keep the same order. */
  order?: Partial<Record<EntityKind, OrderBy>>;
  /** How often to log reads (default 5 min). */
  statsMs?: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

interface KindState {
  entities: Map<string, MirrorEntity>;
  /** Last full read, ms (0: never). */
  at: number;
  count: number;
  error?: string;
  /** After a failed read, not before this. */
  retryAt?: number;
  loading?: Promise<void>;
}

const SWEEP_MS = 2000;
const FLUSH_MS = 200;
const FETCH_CONCURRENCY = 6;
/** Least time between full re-reads forced by a watcher gap. */
const GAP_RECONCILE_MIN_MS = 30_000;
/** The watcher counts as failing for this long after an error. */
const UNHEALTHY_MS = 60_000;
/** Keys remembered as not KINETIC's (or of a kind not mirrored), so their events cost nothing. */
const MAX_REMEMBERED = 50_000;

export function toMirrorEntity(e: StoredEntity): MirrorEntity {
  return {
    key: e.key.toLowerCase(),
    owner: e.owner,
    ...(e.creator ? { creator: e.creator } : {}),
    ...(e.readonly ? { readonly: true } : {}),
    payload: e.payload,
    attrs: Object.fromEntries(Object.entries(e.attrs).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])),
    ...(e.expiresAtMs !== undefined ? { expiresAtMs: e.expiresAtMs } : {}),
  };
}

export class ArkivMirror {
  private readonly state = new Map<EntityKind, KindState>();
  /** What each key is: a mirrored kind, or null for one that isn't (another app's, or an unmirrored kind). */
  private readonly kindOf = new Map<string, EntityKind | null>();
  /** When an event last changed a key, so a full read that started earlier doesn't undo it. */
  private readonly touched = new Map<string, number>();
  private readonly subscribers = new Set<(c: MirrorChange) => void>();
  private readonly pending = new Map<EntityKind, { upserts: Map<string, MirrorEntity>; removes: Set<string> }>();
  private readonly toFetch = new Set<string>();
  private fetching = 0;
  private unwatch: (() => void) | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastUse = 0;
  private lastGapReconcile = 0;
  private lastWatchError = 0;
  // Read accounting, per stats window.
  private window = { start: 0, base: { queries: 0, units: 0, gets: 0, events: 0 } as ReadStats, viewerMs: 0, lastViewerTick: 0, own: 0 };

  constructor(
    private readonly store: ArkivStore,
    private readonly opts: MirrorOptions,
  ) {}

  get running(): boolean {
    return this.unwatch !== null;
  }

  /** The watcher is delivering (no error in the last minute). */
  get live(): boolean {
    return this.running && Date.now() - this.lastWatchError > UNHEALTHY_MS;
  }

  /** A kind's current entities: waits for its first read (up to 8 s), then serves what it has. */
  async snapshot(kind: EntityKind): Promise<MirrorSnapshot> {
    this.use();
    const s = this.kindState(kind);
    if (!s.at && s.loading) await Promise.race([s.loading, new Promise((r) => setTimeout(r, 8000))]);
    if (!s.at) throw new Error(s.error ?? "Arkiv is slow to answer");
    return { kind, at: s.at, count: s.count, live: this.live, entities: this.sorted(kind, [...s.entities.values()]) };
  }

  /** Changes as they happen, batched every FLUSH_MS. Keeps the mirror running while subscribed. */
  subscribe(fn: (c: MirrorChange) => void): () => void {
    this.use();
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
      this.lastUse = Date.now();
    };
  }

  /** Reads so far, and an estimate of what the old polling would have spent while someone watched. */
  stats() {
    const r = this.store.reads;
    const viewerMs = this.window.viewerMs;
    return {
      running: this.running,
      live: this.live,
      since: this.window.start,
      /** The mirror's own metered queries (its full reads). */
      mirrorQueries: this.window.own,
      /** Every metered query this store made (the verifier's own lookups too). */
      queries: r.queries - this.window.base.queries,
      units: r.units - this.window.base.units,
      gets: r.gets - this.window.base.gets,
      events: r.events - this.window.base.events,
      viewerMinutes: Math.round(viewerMs / 6000) / 10,
      pollingQueriesEstimate: Math.round(this.pollingCost(viewerMs)),
      entities: Object.fromEntries([...this.state].map(([k, s]) => [k, s.entities.size])),
    };
  }

  stop(): void {
    this.unwatch?.();
    this.unwatch = null;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const s of this.state.values()) s.at = 0; // stale once nothing keeps it current
  }

  // ── lifecycle ──

  private use(): void {
    this.lastUse = Date.now();
    if (!this.running) this.start();
  }

  private start(): void {
    const log = this.opts.log ?? (() => undefined);
    // The watcher first, then the reads: an event during a read is applied after it, not lost.
    this.unwatch = this.store.watch({
      onEvent: (e) => this.onEvent(e),
      onGap: (reason) => {
        log("Arkiv watcher recreated; re-reading", { reason });
        if (Date.now() - this.lastGapReconcile < GAP_RECONCILE_MIN_MS) return;
        this.lastGapReconcile = Date.now();
        for (const kind of this.state.keys()) void this.reconcile(kind);
      },
      onError: (err) => {
        if (Date.now() - this.lastWatchError > UNHEALTHY_MS) log("Arkiv watcher error", { error: err.message.split("\n")[0]!.slice(0, 160) });
        this.lastWatchError = Date.now();
      },
    });
    for (const kind of this.state.keys()) void this.reconcile(kind);
    this.window = { start: Date.now(), base: { ...this.store.reads }, viewerMs: 0, lastViewerTick: Date.now(), own: 0 };
    const reconcileMs = this.opts.reconcileMs ?? 180_000;
    this.timers.push(
      setInterval(() => this.tick(reconcileMs), SWEEP_MS),
      setInterval(() => this.flush(), FLUSH_MS),
      setInterval(() => this.logStats(), this.opts.statsMs ?? 300_000),
    );
    for (const t of this.timers) t.unref?.();
    log("Arkiv mirror started (live events, full re-read every few minutes)");
  }

  private tick(reconcileMs: number): void {
    const now = Date.now();
    if (this.subscribers.size > 0 || now - this.lastUse < 60_000) this.window.viewerMs += now - this.window.lastViewerTick;
    this.window.lastViewerTick = now;
    if (this.subscribers.size === 0 && now - this.lastUse > (this.opts.idleMs ?? 600_000)) {
      this.logStats();
      (this.opts.log ?? (() => undefined))("Arkiv mirror idle; stopped");
      return this.stop();
    }
    this.sweep(now);
    for (const [kind, s] of this.state) {
      if (s.loading || (s.retryAt ?? 0) > now) continue;
      // While the watcher fails, fall back to the old polling cadence.
      const every = this.live ? reconcileMs : (this.opts.pollMs[kind] ?? 10_000);
      if (now - s.at > every) void this.reconcile(kind);
    }
  }

  private logStats(): void {
    const s = this.stats();
    (this.opts.log ?? (() => undefined))("Arkiv reads", {
      minutes: Math.round((Date.now() - s.since) / 6000) / 10,
      metered: s.mirrorQueries,
      meteredByVerifier: s.queries,
      units: s.units,
      getEntity: s.gets,
      events: s.events,
      viewerMinutes: s.viewerMinutes,
      pollingWouldHaveSpent: s.pollingQueriesEstimate,
      saved: s.pollingQueriesEstimate > 0 ? `${Math.max(0, Math.round((1 - s.mirrorQueries / s.pollingQueriesEstimate) * 100))}%` : "n/a",
    });
    this.window = { start: Date.now(), base: { ...this.store.reads }, viewerMs: 0, lastViewerTick: Date.now(), own: 0 };
  }

  /** What the old proxy spent in viewerMs: each kind re-read every pollMs, one query per 100 entities. */
  private pollingCost(viewerMs: number): number {
    let n = 0;
    for (const [kind, s] of this.state) {
      const every = this.opts.pollMs[kind];
      if (!every) continue;
      n += (viewerMs / every) * Math.max(1, Math.ceil(s.entities.size / 100));
    }
    return n;
  }

  private kindState(kind: EntityKind): KindState {
    let s = this.state.get(kind);
    if (!s) {
      if (!this.opts.kinds.includes(kind)) throw new Error(`unknown kind ${kind}`);
      s = { entities: new Map(), at: 0, count: 0 };
      this.state.set(kind, s);
      // Keys of this kind seen before it was mirrored were remembered as not mirrored.
      for (const [k, v] of this.kindOf) if (v === null) this.kindOf.delete(k);
      void this.reconcile(kind);
    } else if (!s.at && !s.loading) void this.reconcile(kind);
    return s;
  }

  // ── full reads ──

  private reconcile(kind: EntityKind): Promise<void> {
    const s = this.state.get(kind)!;
    if (s.loading) return s.loading;
    const started = Date.now();
    s.loading = this.store
      .queryCounted(kind, {}, { limit: this.opts.limit ?? 2000, ...(this.opts.order?.[kind] ? { orderBy: this.opts.order[kind] } : {}) })
      .then(({ entities, total }) => {
        // Pages of 100, plus the short (or empty) last one.
        this.window.own += Math.floor(entities.length / 100) + 1;
        const next = new Map<string, MirrorEntity>();
        for (const e of entities) {
          const m = toMirrorEntity(e);
          next.set(m.key, m);
          this.remember(m.key, kind);
        }
        // An event applied after this read began is newer than what it returned.
        for (const [key, at] of this.touched) {
          if (at < started || this.kindOf.get(key) !== kind) continue;
          const current = s.entities.get(key);
          if (current) next.set(key, current);
          else next.delete(key);
        }
        for (const [key, m] of next) {
          const old = s.entities.get(key);
          if (!old || JSON.stringify(old) !== JSON.stringify(m)) this.queueChange(kind, m);
        }
        for (const key of s.entities.keys()) if (!next.has(key)) this.queueRemove(kind, key);
        s.entities = next;
        s.count = total;
        s.at = Date.now();
        s.error = undefined;
        for (const [key, at] of this.touched) if (at < started) this.touched.delete(key);
      })
      .catch((err: Error) => {
        s.error = err.message;
        s.retryAt = Date.now() + 15_000; // soon, but not on every tick
      })
      .finally(() => (s.loading = undefined));
    return s.loading;
  }

  /** Arkiv has no expiry event: drop what has expired. */
  private sweep(now: number): void {
    for (const [kind, s] of this.state) {
      for (const [key, e] of s.entities) {
        if (e.expiresAtMs !== undefined && e.expiresAtMs <= now) {
          s.entities.delete(key);
          this.queueRemove(kind, key);
        }
      }
    }
  }

  // ── events ──

  private onEvent(e: StoreEvent): void {
    const known = this.kindOf.get(e.key);
    if (known === null && e.type !== "deleted") return; // not ours, or a kind not mirrored
    const s = known ? this.state.get(known) : undefined;
    const current = s?.entities.get(e.key);
    switch (e.type) {
      case "deleted":
        this.kindOf.delete(e.key);
        if (known && s) {
          this.touched.set(e.key, Date.now());
          if (s.entities.delete(e.key)) this.queueRemove(known, e.key);
        }
        return;
      case "extended":
        if (known && current) {
          if (e.expiresAtMs !== undefined) current.expiresAtMs = e.expiresAtMs;
          this.touched.set(e.key, Date.now());
          this.queueChange(known, current);
          return;
        }
        break;
      case "transferred":
        if (known && current) {
          current.owner = e.owner;
          this.touched.set(e.key, Date.now());
          this.queueChange(known, current);
          return;
        }
        break;
    }
    // Created, patched, or something not yet known: read it.
    this.toFetch.add(e.key);
    this.pump();
  }

  private pump(): void {
    while (this.fetching < FETCH_CONCURRENCY && this.toFetch.size > 0) {
      const key = this.toFetch.values().next().value!;
      this.toFetch.delete(key);
      this.fetching += 1;
      this.store
        .get(key)
        .then((e) => this.applyFetched(key, e))
        .catch(() => undefined) // the next full read covers it
        .finally(() => {
          this.fetching -= 1;
          this.pump();
        });
    }
  }

  private applyFetched(key: string, e: StoredEntity | null): void {
    const known = this.kindOf.get(key);
    if (!e) {
      // Gone (deleted or expired) before we read it.
      const s = known ? this.state.get(known) : undefined;
      if (known && s?.entities.delete(key)) this.queueRemove(known, key);
      return;
    }
    const ours = e.kind && e.attrs.app === this.store.app && this.state.has(e.kind);
    if (!ours) return this.remember(key, null);
    const kind = e.kind!;
    this.remember(key, kind);
    const m = toMirrorEntity(e);
    this.state.get(kind)!.entities.set(key, m);
    this.touched.set(key, Date.now());
    this.queueChange(kind, m);
  }

  private remember(key: string, kind: EntityKind | null): void {
    if (!this.kindOf.has(key) && this.kindOf.size >= MAX_REMEMBERED) this.kindOf.delete(this.kindOf.keys().next().value!);
    this.kindOf.set(key, kind);
  }

  // ── pushing changes ──

  private pendingFor(kind: EntityKind) {
    let p = this.pending.get(kind);
    if (!p) this.pending.set(kind, (p = { upserts: new Map(), removes: new Set() }));
    return p;
  }

  private queueChange(kind: EntityKind, m: MirrorEntity): void {
    const p = this.pendingFor(kind);
    p.removes.delete(m.key);
    p.upserts.set(m.key, m);
  }

  private queueRemove(kind: EntityKind, key: string): void {
    const p = this.pendingFor(kind);
    p.upserts.delete(key);
    p.removes.add(key);
  }

  private flush(): void {
    for (const [kind, p] of this.pending) {
      if (p.upserts.size === 0 && p.removes.size === 0) continue;
      const change: MirrorChange = { kind, upserts: [...p.upserts.values()], removes: [...p.removes] };
      p.upserts.clear();
      p.removes.clear();
      for (const fn of this.subscribers) {
        try {
          fn(change);
        } catch {
          // A broken subscriber is dropped by its own connection's close handler.
        }
      }
    }
  }

  private sorted(kind: EntityKind, list: MirrorEntity[]): MirrorEntity[] {
    const o = this.opts.order?.[kind];
    if (!o) return list;
    const val = (e: MirrorEntity) => (o.attr === "$expiresAt" ? (e.expiresAtMs ?? 0) : (e.attrs[o.attr] ?? ""));
    const dir = o.desc ? -1 : 1;
    return list.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return x < y ? -dir : x > y ? dir : 0;
    });
  }
}
