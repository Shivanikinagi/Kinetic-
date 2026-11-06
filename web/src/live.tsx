import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { getEntities, getReceipts, getStatus, providerColor, short, streamEntities, type Entity, type Kind, type Receipt, type Status } from "./data";

// One source of live data for the whole app. Arkiv entities arrive over the verifier's event
// stream (pushed as Arkiv's entity events come in), or by polling it every few seconds where there
// is no stream; the verifier status and HCS receipts are polled.

export interface Snapshot {
  status: Status;
  offers: Entity[];
  claims: Entity[];
  jobs: Entity[];
  chunks: Entity[];
  reputations: Entity[];
  /** Model registry listings (Arkiv `model` entities); trust them through listingsOf(). */
  models: Entity[];
  receipts: Receipt[];
  at: number;
}

interface Live {
  snap: Snapshot | null;
  error: string | null;
  /** Provider display name for an address, remembered after its offer expires. */
  label: (addr: string) => string;
  gpu: (addr: string) => string;
}

const POLL_MS = 5000;
const LiveContext = createContext<Live>({ snap: null, error: null, label: short, gpu: () => "—" });

const KINDS = ["offers", "claims", "jobs", "chunks", "reputations", "models"] as const;
const ARKIV_KINDS: Kind[] = ["offer", "claim", "job", "chunk", "reputation", "model"];
type Lists = Record<(typeof KINDS)[number], Entity[]>;

/**
 * A provider that restarts publishes a new offer while its last one is still running out its TTL:
 * count each provider once, keeping its newest offer (the latest expiry; else the first, as the
 * verifier sends the newest first).
 */
function oneOfferEach(all: Entity[]): Entity[] {
  const newest = new Map<string, Entity>();
  for (const o of all) {
    const provider = String(o.attrs.provider ?? o.owner);
    const seen = newest.get(provider);
    if (!seen || (o.expiresAtMs ?? 0) > (seen.expiresAtMs ?? 0)) newest.set(provider, o);
  }
  return [...newest.values()];
}

const assemble = (status: Status, lists: Lists, receipts: Receipt[]): Snapshot => ({ status, ...lists, offers: oneOfferEach(lists.offers), receipts, at: Date.now() });

/**
 * Each source loads on its own: one that fails keeps its last value instead of blanking the page.
 * Kinds the event stream delivers are taken from it rather than read again.
 */
async function load(prev: Snapshot | null, streamed: Partial<Record<Kind, Entity[]>>): Promise<{ snap: Snapshot; lists: Lists; failed: string[] }> {
  const status = await getStatus();
  const settled = await Promise.allSettled([...ARKIV_KINDS.map((k) => streamed[k] ?? getEntities(status, k)), getReceipts(status)]);
  const failed: string[] = [];
  const pick = <T,>(i: number, name: string, fallback: T): T => {
    const r = settled[i];
    if (r.status === "fulfilled") return r.value as T;
    failed.push(`${name}: ${(r.reason as Error).message}`);
    return fallback;
  };
  const lists = Object.fromEntries(KINDS.map((k, i) => [k, pick(i, `Arkiv ${k}`, prev?.[k] ?? [])])) as Lists;
  const receipts = pick(6, "HCS receipts", prev?.receipts ?? []);
  return { snap: assemble(status, lists, receipts), lists, failed };
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const names = useRef(new Map<string, { name: string; gpu: string }>());

  useEffect(() => {
    let alive = true;
    let prev: Snapshot | null = null;
    // The full lists behind prev (offers before one-per-provider), so a pushed change can rebuild it.
    let lists: Lists | null = null;
    const streamed: Partial<Record<Kind, Entity[]>> = {};
    const show = (next: Snapshot, failed: string[]) => {
      prev = next;
      for (const r of next.reputations) {
        const p = String(r.attrs.provider);
        if (r.attrs.name && !names.current.has(p)) names.current.set(p, { name: String(r.attrs.name), gpu: String(r.attrs.gpu ?? "—") });
      }
      // Colours are handed out in name order, so a provider keeps its colour across reloads.
      for (const o of [...next.offers].sort((a, b) => String(a.attrs.name).localeCompare(String(b.attrs.name)))) {
        names.current.set(String(o.attrs.provider), { name: String(o.attrs.name), gpu: String(o.attrs.gpu) });
        providerColor(String(o.attrs.provider));
      }
      setSnap(next);
      setError(failed.length ? `showing last known data for ${failed.join("; ")}` : null);
    };
    const tick = async () => {
      try {
        const { snap: next, lists: l, failed } = await load(prev, streamed);
        if (!alive) return;
        lists = l;
        show(next, failed);
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
    };
    // Arkiv changes as they happen: each one redraws at once, with no read of its own.
    let pushTimer: ReturnType<typeof setTimeout> | undefined;
    const stopStream = streamEntities(
      ARKIV_KINDS,
      (kind, entities) => {
        streamed[kind] = entities;
        if (!prev || !lists || pushTimer) return;
        pushTimer = setTimeout(() => {
          pushTimer = undefined;
          if (!alive || !prev || !lists) return;
          for (const [i, k] of ARKIV_KINDS.entries()) if (streamed[k]) lists[KINDS[i]] = streamed[k]!;
          show(assemble(prev.status, lists, prev.receipts), []);
        }, 100);
      },
      // No stream: every kind is polled again.
      () => ARKIV_KINDS.forEach((k) => delete streamed[k]),
    );
    // Sequential polling: a slow refresh delays the next one instead of piling up requests.
    let timer: ReturnType<typeof setTimeout>;
    // A tab in the background doesn't poll: every read spends the network's Arkiv quota.
    const loop = async () => {
      if (!document.hidden) await tick();
      if (alive) timer = setTimeout(loop, POLL_MS);
    };
    const onVisible = () => {
      if (document.hidden || !alive) return;
      clearTimeout(timer);
      void loop();
    };
    document.addEventListener("visibilitychange", onVisible);
    void loop();
    return () => {
      alive = false;
      clearTimeout(timer);
      clearTimeout(pushTimer);
      stopStream?.();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const value: Live = {
    snap,
    error,
    label: (addr) => names.current.get(addr)?.name ?? short(addr),
    gpu: (addr) => names.current.get(addr)?.gpu ?? "—",
  };
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export const useLive = () => useContext(LiveContext);

// ── Hash routing: #/providers, #/jobs/<id>, … ──

const parse = () => location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);

export function useRoute(): string[] {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => {
      setRoute(parse());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const go = (path: string) => {
  location.hash = `#/${path}`;
};
