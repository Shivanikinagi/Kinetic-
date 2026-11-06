import { describe, expect, it } from "vitest";
import { proofOf, rankOffers, recordFromChecks, PROOF_FRESH_SECONDS } from "../src/agent/ranking.js";
import { swarmAddress, swarmChunks, verifiedJoin } from "../src/integrations/swarm-bmt.js";
import type { Offer } from "../src/types.js";

// Swarm content addressing (so downloads don't trust the gateway) and the live check record.

describe("Swarm verified fetch", () => {
  it("matches Bee's reference for a single chunk", () => {
    // POST /bytes "hello" on the public gateway returns this reference.
    expect(swarmAddress(new TextEncoder().encode("hello"))).toBe("a2322ed653c075c08a7847275537b74ba9f523c55341efe3df85565a78c6bb4a");
  });

  it("rebuilds multi-level trees, including a carried last chunk", async () => {
    for (const size of [0, 4096, 4097, 128 * 4096 + 1]) {
      const data = Uint8Array.from({ length: size }, (_, i) => (i * 31) % 251);
      const { reference, chunks } = swarmChunks(data);
      expect(reference).toBe(swarmAddress(data));
      const back = await verifiedJoin(reference, async (a) => chunks.get(a)!);
      expect(Buffer.compare(Buffer.from(back), Buffer.from(data))).toBe(0);
    }
    // Pure-JS keccak over ~130 chunks: slow when the whole suite shares the CPU.
  }, 60_000);

  it("refuses a chunk that doesn't match its address", async () => {
    const data = new TextEncoder().encode("x".repeat(20_000));
    const { reference, chunks } = swarmChunks(data);
    const swapped = async (a: string) => {
      const c = new Uint8Array(chunks.get(a)!);
      if (a !== reference) c[100] ^= 1;
      return c;
    };
    await expect(verifiedJoin(reference, swapped)).rejects.toThrow(/does not match its address/);
  });

  it("reads past parity references in an erasure-coded root", async () => {
    // As the public gateway stores uploads: the root's span carries a redundancy level in its
    // top byte, and parity references follow the data ones.
    const data = Uint8Array.from({ length: 10_000 }, (_, i) => i % 256);
    const { chunks } = swarmChunks(data);
    const leaves = [0, 4096, 8192].map((o) => swarmChunks(data.subarray(o, o + 4096)).reference);
    const parity = "ff".repeat(32);
    const span = new Uint8Array(8);
    new DataView(span.buffer).setBigUint64(0, 10_000n, true);
    span[7] = 0x81;
    const payload = Buffer.concat([...leaves, parity].map((h) => Buffer.from(h, "hex")));
    const { keccak256 } = await import("viem");
    const padded = new Uint8Array(4096);
    padded.set(payload);
    let level: Uint8Array[] = [];
    for (let i = 0; i < 4096; i += 32) level.push(padded.subarray(i, i + 32));
    while (level.length > 1) {
      const next: Uint8Array[] = [];
      for (let i = 0; i < level.length; i += 2) next.push(keccak256(Buffer.concat([level[i], level[i + 1]]), "bytes"));
      level = next;
    }
    const root = Buffer.from(keccak256(Buffer.concat([span, level[0]]), "bytes")).toString("hex");
    const store = new Map(chunks);
    store.set(root, Buffer.concat([span, payload]));
    const back = await verifiedJoin(root, async (a) => {
      if (a === parity) throw new Error("parity chunk fetched");
      return store.get(a)!;
    });
    expect(Buffer.compare(Buffer.from(back), Buffer.from(data))).toBe(0);
  });
});

describe("the live check record", () => {
  const now = Math.floor(Date.now() / 1000);
  const check = (pass: boolean, ago: number) => ({ attrs: { pass: BigInt(pass ? 1 : 0), at: BigInt(now - ago) } });

  it("counts unexpired checks and says how fresh the latest pass is", () => {
    const record = recordFromChecks([check(true, 60), check(false, 120), check(true, 3600)])!;
    expect(record).toMatchObject({ pass: 2, fail: 1, live: true, lastPassAt: now - 60 });
    expect(proofOf(record)).toBe("active");
    expect(proofOf(recordFromChecks([check(true, PROOF_FRESH_SECONDS + 10)]))).toBe("stale");
    expect(proofOf(recordFromChecks([check(false, 10)]))).toBe("unproven");
    expect(recordFromChecks([])).toBeUndefined();
  });

  it("ranks on the live record and labels its proof", () => {
    const offer = (provider: string): Offer => ({ provider, payTo: provider, name: provider, endpoint: "", tasks: ["classify"], gpu: "", priceTinybar: 100n, bondTinybar: 1n });
    const records = new Map([
      ["a", recordFromChecks([check(true, 10), check(true, 20)])!],
      ["b", recordFromChecks([check(false, 10), check(false, 20)])!],
    ]);
    const [first, second, third] = rankOffers([offer("b"), offer("c"), offer("a")], records);
    expect([first.provider, first.rank.proof]).toEqual(["a", "active"]);
    expect([second.provider, second.rank.proof]).toEqual(["c", undefined]);
    expect([third.provider, third.rank.proof]).toEqual(["b", "unproven"]);
  });
});
