// Assurance tiers: the buyer chooses how much verification a job gets, and pays for it.
// Providers compete on price and speed within the tier they can satisfy.
//
//   basic         signed receipts and format checks only: the cheapest, nothing checked
//                 against an answer
//   standard      known answers planted in every chunk, plus hidden canaries against 0G
//   high          standard, and every chunk run by two independent providers whose results
//                 must agree; a disagreement goes to a third, and the majority wins
//   confidential  standard, run only on 0G Compute services whose TEE (TeeML, on a 0G node, not
//                 a relay) signs every response, and every chunk's attestation must verify
//
// "confidential" proves where the model ran. It does not hide the data from the KINETIC
// provider's own process, which decrypts the chunk before sending it to 0G.

export type Tier = "basic" | "standard" | "high" | "confidential";
export const TIERS: Tier[] = ["basic", "standard", "high", "confidential"];

export interface TierRules {
  /** Hidden canaries compared with a 0G reference run. */
  canaries: boolean;
  /** A known-answer item planted in every chunk. */
  knownAnswers: boolean;
  /** Independent providers whose results must agree for each chunk. */
  copies: number;
  /** Only TeeML-attested 0G runs on a 0G node count. */
  attested: boolean;
  /** The verifier's fee, relative to standard. */
  feeScale: number;
}

export const TIER_RULES: Record<Tier, TierRules> = {
  basic: { canaries: false, knownAnswers: false, copies: 1, attested: false, feeScale: 0.2 },
  standard: { canaries: true, knownAnswers: true, copies: 1, attested: false, feeScale: 1 },
  high: { canaries: true, knownAnswers: true, copies: 2, attested: false, feeScale: 1.5 },
  confidential: { canaries: true, knownAnswers: true, copies: 1, attested: true, feeScale: 1.25 },
};

export function parseTier(value?: string): Tier {
  if (!value) return "standard";
  if (!TIERS.includes(value as Tier)) throw new Error(`tier must be one of ${TIERS.join(", ")}, got ${value}`);
  return value as Tier;
}

export function describeTier(t: Tier): string {
  switch (t) {
    case "basic":
      return "basic assurance: signed receipts and format checks only";
    case "standard":
      return "standard assurance: known answers in every chunk and hidden 0G canaries";
    case "high":
      return "high assurance: every chunk run by two independent providers that must agree, plus known answers and canaries";
    case "confidential":
      return "confidential assurance: TeeML-attested 0G runs only, plus known answers and canaries";
  }
}
