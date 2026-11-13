import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ZgStorage } from "../integrations/zg-storage.js";
import { sha256Hex } from "../util/crypto.js";
import type { ModelCard, ModelWeightsFile } from "./card.js";
import { sha256OfFile } from "./safetensors.js";

// Where a model's weights live, and the one way every party fetches them. 0G Storage is built for
// large files (multi-GB weights); a source URL serves weights hosted elsewhere. Whatever the store, the bytes are checked against the sha256 the creator signed in
// the card before anything else touches them.

export interface WeightStores {
  /** 0G Storage, for weights published there (made on first use: it needs a 0G wallet). */
  zg?: () => ZgStorage;
}

export class WeightsFetchError extends Error {}

/** One weights file, from wherever the card says it is, checked against its sha256. */
export async function downloadWeightFile(card: ModelCard, f: ModelWeightsFile, stores: WeightStores): Promise<Uint8Array> {
  let bytes: Uint8Array;
  if (f.zgRoot) {
    if (!stores.zg) throw new WeightsFetchError(`${f.name} is on 0G Storage, and no 0G Storage client is configured`);
    bytes = await stores.zg().download(f.zgRoot);
  } else if (card.weights?.source) {
    const res = await fetch(`${card.weights.source.replace(/\/$/, "")}/${encodeURIComponent(f.name)}`, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!res.ok) throw new WeightsFetchError(`${f.name}: download failed (${res.status})`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } else throw new WeightsFetchError(`${f.name} has no 0G Storage root or source`);
  if (sha256Hex(bytes) !== f.sha256) throw new WeightsFetchError(`${f.name}: the downloaded bytes don't match the sha256 in the card`);
  return bytes;
}

/**
 * The same, written to `path` instead of held in memory: how multi-GB weights are fetched. The
 * file is checked against the card's sha256 and removed again if it doesn't match.
 */
export async function downloadWeightFileTo(card: ModelCard, f: ModelWeightsFile, stores: WeightStores, path: string): Promise<void> {
  await rm(path, { force: true });
  try {
    if (f.zgRoot) {
      if (!stores.zg) throw new WeightsFetchError(`${f.name} is on 0G Storage, and no 0G Storage client is configured`);
      await stores.zg().downloadTo(f.zgRoot, path);
    } else if (card.weights?.source) {
      const res = await fetch(`${card.weights.source.replace(/\/$/, "")}/${encodeURIComponent(f.name)}`, { signal: AbortSignal.timeout(2 * 60 * 60_000) });
      if (!res.ok || !res.body) throw new WeightsFetchError(`${f.name}: download failed (${res.status})`);
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(path));
    } else throw new WeightsFetchError(`${f.name} has no 0G Storage root or source`);
    if ((await sha256OfFile(path)) !== f.sha256) throw new WeightsFetchError(`${f.name}: the downloaded bytes don't match the sha256 in the card`);
  } catch (err) {
    await rm(path, { force: true });
    throw err;
  }
}

/** Where a file is stored, for logs and the dashboard. */
export const storeOf = (f: ModelWeightsFile) => (f.zgRoot ? "0G Storage" : "source");
