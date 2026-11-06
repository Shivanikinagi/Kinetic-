import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { LocalAccount } from "viem";
import { writeJsonAtomic } from "../util/state.js";
import { signStamp, slotsPerBucket } from "./swarm-feed.js";

// Client-side postage stamps for our own batch, so uploads through a public gateway are paid
// storage. A batch of depth d has 65536 buckets (the first two bytes of a chunk address) of
// 2^(d-16) slots each, and a stamp names its (bucket, slot): two chunks stamped into the same
// slot of an immutable batch collide, and one is lost. Every role signs with the same batch
// owner key, so the slot counters live in one file that all of them share (under the state
// directory), updated under a lock. Without a state directory they are kept in memory, which is
// only safe for a single process.

const LOCK_STALE_MS = 30_000;

export class PostageStamper {
  private memory: Record<string, number> = {};

  constructor(
    private readonly account: LocalAccount,
    readonly batchId: string,
    private readonly depth: number,
    private readonly stateFile?: string,
  ) {
    if (!/^[0-9a-f]{64}$/i.test(batchId)) throw new Error("BEE_POSTAGE_BATCH_ID must be 64 hex characters");
    if (!Number.isInteger(depth) || depth < 17 || depth > 255) throw new Error("BEE_POSTAGE_DEPTH must be the batch's depth (17 or more)");
  }

  get issuer(): string {
    return this.account.address.toLowerCase();
  }

  /** Reserves a slot for each chunk address and signs its stamp (hex, 113 bytes). */
  async stamp(addresses: string[]): Promise<string[]> {
    const slots = await this.reserve(addresses);
    const at = Date.now();
    return Promise.all(addresses.map((a, i) => signStamp(this.account, this.batchId, a, slots[i], at)));
  }

  private async reserve(addresses: string[]): Promise<number[]> {
    const max = slotsPerBucket(this.depth);
    const take = (buckets: Record<string, number>) =>
      addresses.map((a) => {
        const bucket = String(parseInt(a.slice(0, 4), 16));
        const slot = buckets[bucket] ?? 0;
        if (slot >= max) throw new Error(`postage batch ${this.batchId.slice(0, 8)}… is full in bucket ${bucket} (${max} slots): top it up with more depth (dilute) or buy a new one`);
        buckets[bucket] = slot + 1;
        return slot;
      });
    if (!this.stateFile) return take(this.memory);
    const file = this.stateFile;
    return this.locked(file, () => {
      let buckets: Record<string, number> = {};
      try {
        buckets = (JSON.parse(readFileSync(file, "utf8")) as { buckets: Record<string, number> }).buckets ?? {};
      } catch {
        // first stamp from this install
      }
      const slots = take(buckets);
      writeJsonAtomic(file, { batchId: this.batchId, depth: this.depth, buckets });
      return slots;
    });
  }

  private async locked<T>(file: string, fn: () => T): Promise<T> {
    const lock = `${file}.lock`;
    mkdirSync(dirname(file), { recursive: true });
    for (let i = 0; ; i++) {
      try {
        mkdirSync(lock);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        try {
          if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
        } catch {
          // released meanwhile
        }
        if (i > 200) throw new Error(`postage stamp counters are locked (${lock})`);
        await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
      }
    }
    try {
      return fn();
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
}
