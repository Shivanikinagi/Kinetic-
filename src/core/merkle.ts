import { createHash } from "node:crypto";
import { canonicalJson } from "../util/crypto.js";

// One HCS anchor per job, as in Hedera's "Batch, anchor, and verify records with HCS" tutorial
// (docs.hedera.com/native/tutorials/consensus/batch-anchor-verify): each record is canonical
// JSON (keys sorted, no whitespace, UTF-8) hashed with SHA-256 into a leaf; a parent is
// SHA-256(left || right) over the raw 32-byte hashes; a level with an odd count duplicates its
// last node; a single leaf is its own root. The root goes on HCS as an `hcs.merkleRootAnchor`
// message, and a proof per record shows it is in the batch without the others.

export const MERKLE_ANCHOR_SCHEMA = "hcs.merkleRootAnchor";
/** The record each finished chunk contributes to its job's anchor (see `chunkLeaf`). */
export const CHUNK_LEAF = "kinetic.chunk.v1";

/** One step up the tree: the sibling's hash and which side it is on (the tutorial's format). */
export interface ProofStep {
  siblingHashHex: string;
  position: "left" | "right";
}

const sha256 = (data: Uint8Array | string): Buffer => createHash("sha256").update(data).digest();

/** SHA-256 of a record's canonical JSON, hex. */
export function leafHash(record: unknown): string {
  return sha256(canonicalJson(record)).toString("hex");
}

function nextLevel(level: Buffer[]): Buffer[] {
  const up: Buffer[] = [];
  for (let i = 0; i < level.length; i += 2) up.push(sha256(Buffer.concat([level[i]!, level[i + 1] ?? level[i]!])));
  return up;
}

/** The Merkle root of leaf hashes (hex), or "" for none. */
export function merkleRoot(leafHashes: string[]): string {
  if (leafHashes.length === 0) return "";
  let level: Buffer[] = leafHashes.map((h) => Buffer.from(h, "hex"));
  while (level.length > 1) level = nextLevel(level);
  return level[0]!.toString("hex");
}

/** The proof that leaf `index` is under the root: its siblings from the bottom up. */
export function merkleProof(leafHashes: string[], index: number): ProofStep[] {
  if (index < 0 || index >= leafHashes.length) throw new Error(`no leaf ${index} of ${leafHashes.length}`);
  const proof: ProofStep[] = [];
  let level: Buffer[] = leafHashes.map((h) => Buffer.from(h, "hex"));
  let i = index;
  while (level.length > 1) {
    const right = i % 2 === 0;
    const sibling = right ? (level[i + 1] ?? level[i]!) : level[i - 1]!;
    proof.push({ siblingHashHex: sibling.toString("hex"), position: right ? "right" : "left" });
    level = nextLevel(level);
    i = Math.floor(i / 2);
  }
  return proof;
}

/** Hashes a leaf up through its proof and compares with the root. */
export function verifyMerkleProof(leafHashHex: string, rootHex: string, proof: ProofStep[]): boolean {
  let current: Buffer = Buffer.from(leafHashHex, "hex");
  for (const step of proof) {
    const sibling = Buffer.from(step.siblingHashHex, "hex");
    current = sha256(step.position === "right" ? Buffer.concat([current, sibling]) : Buffer.concat([sibling, current]));
  }
  return current.toString("hex") === rootHex;
}

/**
 * The record a finished chunk contributes to its job's anchor: what the verifier accepted (who
 * produced it, the result hash they signed, the payment), so every field is also in the Compute
 * Passport and anyone can rebuild the leaves from it.
 */
export function chunkLeaf(jobId: string, w: { idx: number; provider: string; resultHash: string; payTx?: string }) {
  return { job: jobId, idx: w.idx, provider: w.provider.toLowerCase(), resultHash: w.resultHash, ...(w.payTx ? { payTx: w.payTx } : {}) };
}

/** A job's chunk leaves, in chunk order. */
export function chunkLeaves(jobId: string, chunks: { idx: number; provider: string; resultHash: string; payTx?: string }[]): string[] {
  return [...chunks].sort((a, b) => a.idx - b.idx).map((w) => leafHash(chunkLeaf(jobId, w)));
}
