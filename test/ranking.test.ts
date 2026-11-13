import { describe, expect, it } from "vitest";
import { parseStrategy, proofOf, rankOffers, recordFromChecks, reliabilityOf, PROOF_FRESH_SECONDS, type TrackRecord } from "../src/agent/ranking.js";
import type { Offer } from "../src/types.js";

const offer = (provider: string, price: bigint): Offer => ({ provider, payTo: provider, name: provider, endpoint: "", tasks: ["classify"], gpu: "", priceTinybar: price, bondTinybar: 100_000_000n });

describe("provider ranking", () => {
  it("gives a newcomer an even reliability estimate", () => {
    expect(reliabilityOf()).toBe(0.5);
    expect(reliabilityOf({ pass: 8, fail: 0 })).toBe(0.9);
    expect(reliabilityOf({ pass: 0, fail: 8 })).toBe(0.1);
  });

  it("ranks by price when nobody has a track record", () => {
    const ranked = rankOffers([offer("b", 120_000n), offer("a", 60_000n), offer("c", 100_000n)], new Map());
    expect(ranked.map((o) => o.provider)).toEqual(["a", "c", "b"]);
    expect(ranked[0].rank.price).toBe(1);
  });

  it("puts a reliable provider ahead of a cheaper one that keeps failing checks", () => {
    const records = new Map<string, TrackRecord>([
      ["cheap", { pass: 2, fail: 8 }],
      ["solid", { pass: 20, fail: 0 }],
    ]);
    const ranked = rankOffers([offer("cheap", 60_000n), offer("solid", 100_000n)], records, "balanced");
    expect(ranked[0].provider).toBe("solid");
    expect(ranked[0].rank.checks).toBe(20);
  });

  it("lets the strategy decide between cheap-and-slow and fast-and-pricier", () => {
    const records = new Map<string, TrackRecord>([
      ["slow", { pass: 10, fail: 0, latencyMs: 12_000 }],
      ["fast", { pass: 10, fail: 0, latencyMs: 1_000 }],
    ]);
    const offers = [offer("slow", 60_000n), offer("fast", 120_000n)];
    expect(rankOffers(offers, records, "cheapest")[0].provider).toBe("slow");
    expect(rankOffers(offers, records, "fastest")[0].provider).toBe("fast");
  });

  it("treats an unmeasured provider as typical speed", () => {
    const records = new Map<string, TrackRecord>([
      ["a", { pass: 0, fail: 0, latencyMs: 1_000 }],
      ["b", { pass: 0, fail: 0, latencyMs: 3_000 }],
    ]);
    const ranked = rankOffers([offer("a", 1n), offer("b", 1n), offer("new", 1n)], records);
    expect(ranked.find((o) => o.provider === "new")!.rank.speed).toBe(ranked.find((o) => o.provider === "b")!.rank.speed);
  });

  it("rejects an unknown strategy", () => {
    expect(parseStrategy()).toBe("balanced");
    expect(() => parseStrategy("random")).toThrow(/strategy/);
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
