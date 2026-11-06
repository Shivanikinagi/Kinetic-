import type { Item } from "../types.js";

/** Splits a job into independent, fixed-size chunks. Chunk i holds items[i*size, (i+1)*size). */
export function splitIntoChunks(items: Item[], chunkSize: number): Item[][] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error(`chunkSize must be a positive integer, got ${chunkSize}`);
  const chunks: Item[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) chunks.push(items.slice(i, i + chunkSize));
  return chunks;
}
