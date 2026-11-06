import { keccak256, toBytes, type Hex } from "viem";
import { sha256Hex } from "../util/crypto.js";

// Spot checks drawn with Hedera's PRNG, after the work.
//
// Canaries can't come from public randomness: they must stay secret until the job ends, and a
// seed on the ledger is public the moment it exists. So the PRNG picks something else: extra
// chunks to re-run on 0G once the job is closed. The verifier draws one seed per job in the
// bond vault (HIP-351, `drawSeed`), only after the job's canary reveal is on HCS, so every
// result was already signed and receipted before the seed existed: no provider could know which
// chunks would be re-checked, and the verifier gets one draw per job, timestamped on-chain, so
// it can't pick the chunks either. Anyone can recompute the picks from the seed.

export const SPOT_TAG_PREFIX = "kinetic.spot.v1:";

/** The vault tag a job's spot-check seed is drawn under. */
export const spotTag = (jobId: string): Hex => keccak256(toBytes(`${SPOT_TAG_PREFIX}${jobId}`));

/**
 * `count` chunks from `candidates`, chosen by the seed alone: a Fisher-Yates draw where each
 * step's index is sha256(seed | jobId | step) mod the number left. Returned in chunk order.
 */
export function spotPicks(seed: string, jobId: string, candidates: number[], count: number): number[] {
  const pool = [...new Set(candidates)].sort((a, b) => a - b);
  const picks: number[] = [];
  for (let step = 0; step < count && pool.length > 0; step++) {
    const r = BigInt(`0x${sha256Hex(`${seed.toLowerCase()}|${jobId}|${step}`)}`) % BigInt(pool.length);
    picks.push(pool.splice(Number(r), 1)[0]!);
  }
  return picks.sort((a, b) => a - b);
}

/** The chunks a job's spot checks may pick: every finished chunk that wasn't a canary. */
export function spotCandidates(finished: number[], canaries: number[]): number[] {
  const checked = new Set(canaries);
  return finished.filter((idx) => !checked.has(idx));
}
