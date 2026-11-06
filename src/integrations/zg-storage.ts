import { DEFAULT_CHUNK_SIZE, DEFAULT_SEGMENT_MAX_CHUNKS, Downloader, Indexer, MemData, StorageNode, Uploader, ZgFile } from "@0gfoundation/0g-storage-ts-sdk";
import { JsonRpcProvider, Wallet } from "ethers";
import { randomBytes } from "node:crypto";
import { open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import type { NetworkConfig } from "../config.js";
import { sha256Hex } from "../util/crypto.js";

// 0G Storage: content-addressed storage built for large files, used for model weights. A file is
// addressed by the Merkle root of its contents. Uploading is an on-chain `submit` to 0G's Flow
// contract with a storage fee (a funded 0G wallet); downloading needs no wallet.
//
// The SDK's "download with proof" flag doesn't verify anything yet (its downloader has a TODO), so
// every download is checked here by recomputing the root hash from the bytes received.

export interface ZgStorage {
  /** Stores bytes; returns the file's root hash (0x + 64 hex) and the upload transaction ("" when it was already stored). */
  upload(bytes: Uint8Array): Promise<{ root: string; tx?: string }>;
  /** The file under a root hash, checked against it. */
  download(root: string): Promise<Uint8Array>;
  /** Stores a file from disk, without reading it into memory: the path for large weights. */
  uploadFile(path: string): Promise<{ root: string; tx?: string }>;
  /** Writes the file under a root hash to `path` (which must not exist yet), checked against the root. */
  downloadTo(root: string, path: string): Promise<void>;
}

/** One file is one root up to 4 GiB; the SDK splits larger files into fragments with a root each. */
export const MAX_ZG_FILE_BYTES = 4 * 1024 ** 3;

const UPLOAD_TIMEOUT_MS = 60 * 60_000;

/** 0G Storage moves data in 256 KiB segments. */
const SEGMENT_BYTES = 256 * 1024;
/** Upload requests kept in flight at once. */
const UPLOAD_PARALLEL = 16;
const UPLOAD_ATTEMPTS = 3;
/** Segments per request: 16 × 256 KiB = 4 MiB, well under the 10 MB request limit. */
const MAX_TASK_SEGMENTS = 16;
/** Upload requests in flight at once: they share the uplink, so fewer finish sooner each. */
const UPLOAD_CONCURRENCY = 4;
/** Per request to a storage node; the SDK's JSON-RPC client defaults to 30 s, too short for 4 MiB on a home uplink. */
const NODE_REQUEST_TIMEOUT_MS = 5 * 60_000;

// The SDK constructs its storage node clients without a timeout, so they take the JSON-RPC client's
// 30 s default, and a non-retryable timeout fails the upload. This raises it for every node client;
// the client reads `this.timeout` per request, and the constructor's assignment is ignored.
Object.defineProperty(StorageNode.prototype, "timeout", { get: () => NODE_REQUEST_TIMEOUT_MS, set: () => {}, configurable: true });

// The SDK starts every upload task at once (Promise.all over the whole file), so a large file puts
// all of it in flight together and requests time out against the storage nodes' 30 s limit. This
// runs the same tasks a few at a time instead, in order; nothing else about the upload changes.
type TaskRunner = { uploadTask(file: unknown, tree: unknown, task: unknown, retryOpts: unknown): Promise<unknown> };
(Uploader.prototype as unknown as { processTasksInParallel: (this: TaskRunner, file: unknown, tree: unknown, tasks: unknown[], retryOpts: unknown) => Promise<unknown[]> }).processTasksInParallel = async function (file, tree, tasks, retryOpts) {
  const results: unknown[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await this.uploadTask(file, tree, tasks[i], retryOpts);
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, tasks.length) }, worker));
  return results;
};

/** Segment downloads in flight at once. */
const DOWNLOAD_CONCURRENCY = 8;

// The SDK downloads a file one 256 KiB segment after another, each a round trip to a storage node:
// a 270 MB file took 15 minutes. This fetches the same segments a few at a time and joins them in
// order; each segment is still fetched by the SDK's own `downloadTask`.
type SegmentFetcher = {
  startSegmentIndex: number;
  endSegmentIndex: number;
  downloadTask(info: unknown, segmentOffset: number, taskInd: number, numChunks: number, proof: unknown): Promise<[Uint8Array, Error | null]>;
};
type FileInfo = { tx: { size: number; startEntryIndex: number } };
(Downloader.prototype as unknown as { downloadFileHelperToBlob: (this: SegmentFetcher, info: FileInfo, proof: unknown) => Promise<[Blob, Error | null]> }).downloadFileHelperToBlob = async function (info, proof) {
  const numChunks = Math.ceil(info.tx.size / DEFAULT_CHUNK_SIZE);
  this.startSegmentIndex = Math.floor(info.tx.startEntryIndex / DEFAULT_SEGMENT_MAX_CHUNKS);
  this.endSegmentIndex = Math.floor((info.tx.startEntryIndex + numChunks - 1) / DEFAULT_SEGMENT_MAX_CHUNKS);
  const numTasks = this.endSegmentIndex - this.startSegmentIndex + 1;
  const segments: Uint8Array[] = new Array(numTasks);
  let next = 0;
  let failed: Error | null = null;
  const worker = async () => {
    while (next < numTasks && !failed) {
      const i = next++;
      const [seg, err] = await this.downloadTask(info, 0, i, numChunks, proof);
      if (err) failed ??= err;
      else segments[i] = seg;
    }
  };
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, numTasks) }, worker));
  return failed ? [new Blob(), failed] : [new Blob(segments as BlobPart[]), null];
};

// The same for downloads to a file (multi-GB weights): segments are fetched a few at a time and
// each is written at its own offset, so the file comes out in order whatever finishes first.
(Downloader.prototype as unknown as { downloadFileHelper: (this: SegmentFetcher, filePath: string, info: FileInfo, proof: unknown) => Promise<Error | null> }).downloadFileHelper = async function (filePath, info, proof) {
  const numChunks = Math.ceil(info.tx.size / DEFAULT_CHUNK_SIZE);
  this.startSegmentIndex = Math.floor(info.tx.startEntryIndex / DEFAULT_SEGMENT_MAX_CHUNKS);
  this.endSegmentIndex = Math.floor((info.tx.startEntryIndex + numChunks - 1) / DEFAULT_SEGMENT_MAX_CHUNKS);
  const numTasks = this.endSegmentIndex - this.startSegmentIndex + 1;
  const segmentBytes = DEFAULT_CHUNK_SIZE * DEFAULT_SEGMENT_MAX_CHUNKS;
  const out = await open(filePath, "wx");
  let next = 0;
  let failed: Error | null = null;
  try {
    const worker = async () => {
      while (next < numTasks && !failed) {
        const i = next++;
        const [seg, err] = await this.downloadTask(info, 0, i, numChunks, proof);
        if (err) failed ??= err;
        else await out.write(seg, 0, seg.length, i * segmentBytes);
      }
    };
    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, numTasks) }, worker));
  } finally {
    await out.close();
  }
  return failed;
};

/** Above this, bytes go through a temporary file: the SDK's in-memory Merkle tree slows down sharply with size. */
const MEMORY_UPLOAD_MAX = 16 * 1024 * 1024;

type ZgSigner = Parameters<Indexer["upload"]>[2];

export class ZgStorageClient implements ZgStorage {
  private readonly indexer: Indexer;
  private readonly signer?: ZgSigner;

  constructor(
    private readonly cfg: NetworkConfig["zgStorage"],
    /** The uploader's key (0x hex). Downloads need none. */
    privateKey?: Hex,
  ) {
    this.indexer = new Indexer(cfg.indexerUrl);
    // The SDK's typings resolve ethers' CommonJS build; the runtime object is the same.
    if (privateKey) this.signer = new Wallet(privateKey, new JsonRpcProvider(cfg.rpcUrl)) as unknown as ZgSigner;
  }

  async upload(bytes: Uint8Array): Promise<{ root: string; tx?: string }> {
    if (!this.signer) throw new Error("uploading to 0G Storage needs a key with 0G for the storage fee");
    if (bytes.length > MAX_ZG_FILE_BYTES) throw new Error(`0G Storage files are stored as one root up to ${MAX_ZG_FILE_BYTES} bytes; split larger weights into shards`);
    if (bytes.length <= MEMORY_UPLOAD_MAX) return this.uploadData(new MemData(bytes));
    const path = join(tmpdir(), `kinetic-zg-${randomBytes(6).toString("hex")}.bin`);
    await writeFile(path, bytes);
    try {
      return await this.uploadFile(path);
    } finally {
      await rm(path, { force: true });
    }
  }

  /** Uploads a file from disk: the fast path for large weights. */
  async uploadFile(path: string): Promise<{ root: string; tx?: string }> {
    const file = await ZgFile.fromFilePath(path);
    try {
      return await this.uploadData(file);
    } finally {
      await file.close();
    }
  }

  private async uploadData(data: MemData | ZgFile): Promise<{ root: string; tx?: string }> {
    // The SDK sends every task at once, and by default each task is one 256 KiB segment: a large
    // file floods the storage nodes with hundreds of requests, which they reset. Packing segments
    // into tasks (up to MAX_TASK_SEGMENTS) keeps far fewer requests in flight. `skipTx` makes the SDK submit
    // (and pay for) the Flow transaction only when the file isn't registered yet, so a retry, or a
    // resumed upload of a file already paid for, never pays twice.
    const segments = Math.ceil(data.size() / SEGMENT_BYTES);
    // A task's segments go in one request, which the SDK's HTTP client caps at 10 MB.
    const opts = { expectedReplica: 1, taskSize: Math.min(MAX_TASK_SEGMENTS, Math.max(1, Math.ceil(segments / UPLOAD_PARALLEL))), skipTx: true };
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const [res, err] = await Promise.race([
          this.indexer.upload(data, this.cfg.rpcUrl, this.signer!, opts as never),
          new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`0G Storage upload didn't finish in ${UPLOAD_TIMEOUT_MS / 60_000} minutes`)), UPLOAD_TIMEOUT_MS))),
        ]).finally(() => clearTimeout(timer));
        if (err) throw err;
        if (!("rootHash" in res)) throw new Error("0G Storage split the file into fragments; KINETIC stores one root per file");
        return { root: res.rootHash, ...(res.txHash ? { tx: res.txHash } : {}) };
      } catch (err) {
        lastError = err as Error;
        // Not worth retrying: no funds for the fee, or a file 0G can't take as one root.
        if (/insufficient funds|fragments/i.test(lastError.message) || attempt === UPLOAD_ATTEMPTS) break;
        await new Promise((r) => setTimeout(r, 5000 * attempt));
      }
    }
    throw new Error(`0G Storage upload failed: ${lastError?.message ?? "unknown error"}`);
  }

  async download(root: string): Promise<Uint8Array> {
    let blob: Blob;
    try {
      const [b, err] = await this.indexer.downloadToBlob(root, { proof: true });
      if (err || !b) throw err ?? new Error("no data");
      blob = b;
    } catch (err) {
      throw new Error(`0G Storage download of ${root.slice(0, 12)}… failed: ${(err as Error).message}`);
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if ((await rootOf(bytes)) !== root) throw new Error(`0G Storage returned bytes that don't hash to ${root.slice(0, 12)}…`);
    return bytes;
  }

  async downloadTo(root: string, path: string): Promise<void> {
    let err: Error | null;
    try {
      err = await this.indexer.download(root, path, true);
    } catch (e) {
      err = e as Error;
    }
    if (err) {
      await rm(path, { force: true });
      throw new Error(`0G Storage download of ${root.slice(0, 12)}… failed: ${err.message}`);
    }
    if ((await rootOfFile(path)) !== root) {
      await rm(path, { force: true });
      throw new Error(`0G Storage returned bytes that don't hash to ${root.slice(0, 12)}…`);
    }
  }
}

/** 0G Storage's Merkle root of a file on disk, computed without reading it all into memory. */
export async function rootOfFile(path: string): Promise<string | undefined> {
  const file = await ZgFile.fromFilePath(path);
  try {
    return (await file.merkleTree())[0]?.rootHash() ?? undefined;
  } finally {
    await file.close();
  }
}

/** 0G Storage's Merkle root of some bytes (through a temporary file when large: much faster). */
export async function rootOf(bytes: Uint8Array): Promise<string | undefined> {
  if (bytes.length <= MEMORY_UPLOAD_MAX) return (await new MemData(bytes).merkleTree())[0]?.rootHash() ?? undefined;
  const path = join(tmpdir(), `kinetic-zg-${randomBytes(6).toString("hex")}.bin`);
  await writeFile(path, bytes);
  try {
    return await rootOfFile(path);
  } finally {
    await rm(path, { force: true });
  }
}

/** The tests' stand-in, served by the devnet emulator. Its "root" is a sha256, not 0G's Merkle root. */
export class DevnetZgStorage implements ZgStorage {
  constructor(private readonly devnetUrl: string) {}

  async upload(bytes: Uint8Array): Promise<{ root: string; tx?: string }> {
    const res = await fetch(`${this.devnetUrl}/zgs/upload`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(bytes) });
    if (!res.ok) throw new Error(`devnet 0G Storage upload failed (${res.status})`);
    return (await res.json()) as { root: string; tx?: string };
  }

  async uploadFile(path: string): Promise<{ root: string; tx?: string }> {
    return this.upload(new Uint8Array(await readFile(path)));
  }

  async downloadTo(root: string, path: string): Promise<void> {
    await writeFile(path, await this.download(root), { flag: "wx" });
  }

  async download(root: string): Promise<Uint8Array> {
    const res = await fetch(`${this.devnetUrl}/zgs/${root}`);
    if (!res.ok) throw new Error(`devnet 0G Storage download of ${root.slice(0, 12)}… failed (${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (`0x${sha256Hex(bytes)}` !== root) throw new Error("devnet 0G Storage returned the wrong bytes");
    return bytes;
  }
}
