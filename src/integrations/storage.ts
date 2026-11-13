import type { NetworkConfig } from "../config.js";
import { isStorageRef, storageUrl } from "./storage-ref.js";
import { DevnetZgStorage, ZgStorageClient, type ZgStorage } from "./zg-storage.js";

export { isStorageRef, storageUrl };

// Where KINETIC keeps its public documents: Compute Passports and Model Passports, on 0G Storage.
// A document is addressed by the 0G Merkle root of its bytes (0x + 64 hex), and every download is
// checked against that root, so whoever serves the bytes can't change them.
//
// Job data never goes here: each chunk travels to its GPU encrypted inside the x402 request.

export class DocumentStore {
  constructor(
    private readonly zg: () => ZgStorage,
    /** The 0G Storage indexer, whose GET /file?root= serves any stored file over HTTP. */
    readonly gateway: string,
  ) {}

  /** Stores bytes on 0G; returns their root. Costs a small 0G fee from the uploader's wallet. */
  async upload(bytes: Uint8Array): Promise<string> {
    return (await this.zg().upload(bytes)).root;
  }

  /** The bytes under a root, checked against it. */
  async download(ref: string): Promise<Uint8Array> {
    if (!isStorageRef(ref)) throw new Error(`${ref.slice(0, 16)}… is not a 0G Storage root`);
    return this.zg().download(ref);
  }

  /** A public link to a stored document. */
  url(ref: string): string {
    return storageUrl(this.gateway, ref);
  }
}

/**
 * The document store for a role. `privateKey` pays 0G's storage fee for uploads; without one the
 * store can only read. On devnet it's the emulator's stand-in.
 */
export function documentStore(cfg: NetworkConfig, privateKey?: `0x${string}`): DocumentStore {
  const dev = cfg.network === "devnet";
  let zg: ZgStorage | undefined;
  const make = () => (zg ??= dev ? new DevnetZgStorage(cfg.devnetUrl) : new ZgStorageClient(cfg.zgStorage, privateKey));
  return new DocumentStore(make, cfg.zgStorage.indexerUrl);
}
