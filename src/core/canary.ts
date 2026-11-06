import { randomBytes, randomInt } from "node:crypto";
import { sha256Hex } from "../util/crypto.js";

// Canaries are ordinary chunks of the buyer's own job, picked at random by the verifier.
// Providers see identical requests for every chunk, so they cannot tell which ones are
// checked. The verifier commits to the set on HCS before any chunk runs and reveals it at
// the end, so it cannot pick canaries after seeing results either.

export interface CanaryPlan {
  indices: number[];
  salt: string;
  commitment: string;
}

export function selectCanaries(chunkCount: number, rate: number, min = 1): number[] {
  if (chunkCount === 0) return [];
  const target = Math.min(chunkCount, Math.max(min, Math.round(chunkCount * rate)));
  const pool = Array.from({ length: chunkCount }, (_, i) => i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, target).sort((a, b) => a - b);
}

export function commitCanaries(jobId: string, indices: number[], salt: string): string {
  return sha256Hex(`${jobId}|${[...indices].sort((a, b) => a - b).join(",")}|${salt}`);
}

export function planCanaries(jobId: string, chunkCount: number, rate: number, min = 1): CanaryPlan {
  const indices = selectCanaries(chunkCount, rate, min);
  const salt = randomBytes(16).toString("hex");
  return { indices, salt, commitment: commitCanaries(jobId, indices, salt) };
}

export function verifyReveal(jobId: string, indices: number[], salt: string, commitment: string): boolean {
  return commitCanaries(jobId, indices, salt) === commitment;
}
