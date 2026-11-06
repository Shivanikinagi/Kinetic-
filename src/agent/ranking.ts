import type { Offer, ProviderRank } from "../types.js";

// Provider choice. Every offer gets a score from three signals the buyer can check:
//   price        its quote against the cheapest eligible quote
//   reliability  the verifier's pass/fail record on Arkiv, smoothed so one result isn't everything:
//                its unexpired check entities when there are any, else the lifetime reputation
//   speed        median measured latency against the fastest known provider
// The strategy sets the weights. The buyer works with the best-ranked providers first and keeps
// the rest as reserves that step in when one drops out.

export type Strategy = "cheapest" | "balanced" | "fastest";

export const STRATEGIES: Strategy[] = ["cheapest", "balanced", "fastest"];

const WEIGHTS: Record<Strategy, { price: number; reliability: number; speed: number }> = {
  cheapest: { price: 0.6, reliability: 0.3, speed: 0.1 },
  balanced: { price: 0.4, reliability: 0.4, speed: 0.2 },
  fastest: { price: 0.15, reliability: 0.35, speed: 0.5 },
};

/** A provider's history as the verifier recorded it. */
export interface TrackRecord {
  pass: number;
  fail: number;
  latencyMs?: number;
  /** Unix seconds of its latest live passing check, when the record comes from check entities. */
  lastPassAt?: number;
  /** True when pass/fail count only unexpired check entities (not the lifetime totals). */
  live?: boolean;
}

/** A pass this recent means the provider is proven to work now, not just claimed to. */
export const PROOF_FRESH_SECONDS = 6 * 3600;

/**
 * A provider's record from the verifier's unexpired check entities on Arkiv: what's counted is
 * what hasn't expired, so the record ages on its own.
 */
export function recordFromChecks(checks: { attrs: Record<string, string | bigint> }[]): TrackRecord | undefined {
  if (checks.length === 0) return undefined;
  let pass = 0;
  let fail = 0;
  let lastPassAt: number | undefined;
  for (const c of checks) {
    if (Number(c.attrs.pass ?? 0) === 1) {
      pass += 1;
      const at = Number(c.attrs.at ?? 0);
      if (!lastPassAt || at > lastPassAt) lastPassAt = at;
    } else fail += 1;
  }
  return { pass, fail, live: true, ...(lastPassAt ? { lastPassAt } : {}) };
}

/** "active": a live pass in the last PROOF_FRESH_SECONDS; "stale": only older ones; "unproven": none. */
export function proofOf(record: TrackRecord | undefined, now = Date.now() / 1000): NonNullable<ProviderRank["proof"]> {
  if (!record?.lastPassAt) return "unproven";
  return now - record.lastPassAt <= PROOF_FRESH_SECONDS ? "active" : "stale";
}

/** Below this many checks, a low reliability estimate is not enough evidence to skip a provider. */
export const MIN_CHECKS_TO_SKIP = 5;

export function reliabilityOf(record?: TrackRecord): number {
  const pass = record?.pass ?? 0;
  const fail = record?.fail ?? 0;
  return (pass + 1) / (pass + fail + 2);
}

export function parseStrategy(value?: string): Strategy {
  if (!value) return "balanced";
  if (!STRATEGIES.includes(value as Strategy)) throw new Error(`strategy must be one of ${STRATEGIES.join(", ")}, got ${value}`);
  return value as Strategy;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/** Scores and sorts offers, best first. Ties go to the cheaper offer. */
export function rankOffers<T extends Offer>(offers: T[], records: Map<string, TrackRecord>, strategy: Strategy = "balanced"): (T & { rank: ProviderRank })[] {
  const prices = offers.map((o) => o.priceTinybar).filter((p) => p > 0n);
  const cheapest = prices.length ? prices.reduce((a, b) => (b < a ? b : a)) : 0n;
  const latencies = offers
    .map((o) => records.get(o.provider)?.latencyMs)
    .filter((l): l is number => typeof l === "number" && l > 0)
    .sort((a, b) => a - b);
  const fastest = latencies[0];
  // A provider with no measured latency is assumed typical, not fast or slow.
  const typical = latencies.length ? latencies[Math.floor(latencies.length / 2)] : undefined;
  const w = WEIGHTS[strategy];

  return offers
    .map((o) => {
      const record = records.get(o.provider);
      const price = o.priceTinybar > 0n && cheapest > 0n ? Number(cheapest) / Number(o.priceTinybar) : 1;
      const latencyMs = record?.latencyMs && record.latencyMs > 0 ? record.latencyMs : undefined;
      const effective = latencyMs ?? typical;
      const speed = fastest && effective ? fastest / effective : 1;
      const reliability = reliabilityOf(record);
      const rank: ProviderRank = {
        score: round(w.price * price + w.reliability * reliability + w.speed * speed),
        price: round(price),
        reliability: round(reliability),
        speed: round(speed),
        checks: (record?.pass ?? 0) + (record?.fail ?? 0),
        ...(latencyMs ? { latencyMs } : {}),
        ...(record?.live ? { proof: proofOf(record) } : {}),
      };
      return { ...o, rank };
    })
    .sort((a, b) => b.rank.score - a.rank.score || (a.priceTinybar < b.priceTinybar ? -1 : a.priceTinybar > b.priceTinybar ? 1 : 0));
}
