import { TIER_RULES, type Tier } from "./tiers.js";

// A firm quote: before any work, the most this job can cost the buyer, from the live offers.
// It is committed in the job agreement (whose hash goes on HCS before work), and the buyer
// agent never spends past it: once the next payment would cross it, paid work stops. Refunds
// from slashed providers come back on top, so the real net cost is usually lower.

export interface Quote {
  /** Chunks in the job. */
  chunks: number;
  /** Extra chunk payments allowed for reroutes and re-checks (failed chunks are paid, then redone). */
  allowance: number;
  /** The highest price among the providers that might do the work, in tinybar. */
  maxPricePerChunk: string;
  /** (chunks + allowance) × maxPricePerChunk. */
  work: string;
  /** The verifier's fee for this job, as it computes it. */
  fee: string;
  /** A model job: the most the creator's royalty can be (its share of `work`). */
  royalty?: string;
  /** work + fee + royalty: the most the buyer can pay. */
  total: string;
}

export const REROUTE_ALLOWANCE = 0.25;

export interface QuoteTerms {
  chunks: number;
  /** Per-chunk prices of every provider that might work on the job (working or reserve). */
  prices: bigint[];
  feePerChunk: bigint;
  /** The job's agreed check rate and the verifier's own; checking more costs proportionally more. */
  canaryRate: number;
  protocolRate: number;
  tier?: Tier;
  /** A model job's royalty, in basis points of the provider payments. */
  royaltyBps?: number;
}

/**
 * The verifier's fee for a job: per chunk, scaled up when the buyer asks for more checks than its
 * rate, and by the assurance tier (basic is a fifth of standard; high and confidential cost more).
 */
export function verifierFee(chunks: number, feePerChunk: bigint, canaryRate: number, protocolRate: number, tier: Tier = "standard"): bigint {
  const scale = (tier === "basic" ? 1 : Math.max(1, canaryRate / protocolRate)) * TIER_RULES[tier].feeScale;
  return BigInt(Math.ceil(Number(feePerChunk * BigInt(chunks)) * scale));
}

export function makeQuote({ chunks, prices, feePerChunk, canaryRate, protocolRate, tier = "standard", royaltyBps = 0 }: QuoteTerms): Quote {
  const maxPrice = prices.reduce((a, b) => (b > a ? b : a), 0n);
  // High assurance pays for every chunk twice, and the allowance covers tie-breaking copies too.
  const paidRuns = chunks * TIER_RULES[tier].copies;
  const allowance = chunks === 0 ? 0 : Math.max(1, Math.ceil(paidRuns * REROUTE_ALLOWANCE));
  const work = BigInt(paidRuns + allowance) * maxPrice;
  const fee = verifierFee(chunks, feePerChunk, canaryRate, protocolRate, tier);
  // Royalties are paid on accepted chunks only, which never cost more than `work`.
  const royalty = royaltyBps > 0 ? (work * BigInt(royaltyBps) + 9_999n) / 10_000n : 0n;
  return { chunks, allowance, maxPricePerChunk: maxPrice.toString(), work: work.toString(), fee: fee.toString(), ...(royaltyBps > 0 ? { royalty: royalty.toString() } : {}), total: (work + fee + royalty).toString() };
}
