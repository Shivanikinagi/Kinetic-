import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPassport, type Passport } from "../src/agent/passport.js";
import { passportSchema } from "../src/agent/passport-schema.js";
import { chunkLeaf, chunkLeaves, leafHash, merkleProof, merkleRoot, verifyMerkleProof } from "../src/core/merkle.js";
import { spotCandidates, spotPicks, spotTag } from "../src/core/spot.js";
import { readReceipts } from "../src/integrations/hcs.js";
import { runScenario, type Scenario } from "./support/scenario.js";

// One HCS Merkle anchor per job, and PRNG spot checks drawn after the reveal.

const sha = (b: Buffer) => createHash("sha256").update(b).digest();

describe("Merkle anchor (Hedera batch-anchor-verify)", () => {
  const leaves = (n: number) => Array.from({ length: n }, (_, i) => leafHash({ id: `record-${i}`, n: i }));

  it("hashes canonical JSON leaves, pairs raw bytes, and duplicates the last node on odd levels", () => {
    expect(leafHash({ b: 2, a: 1 })).toBe(createHash("sha256").update('{"a":1,"b":2}').digest("hex"));
    const [a, b, c] = leaves(3).map((h) => Buffer.from(h, "hex"));
    const expected = sha(Buffer.concat([sha(Buffer.concat([a!, b!])), sha(Buffer.concat([c!, c!]))])).toString("hex");
    expect(merkleRoot(leaves(3))).toBe(expected);
    expect(merkleRoot(leaves(1))).toBe(leaves(1)[0]);
    expect(merkleRoot([])).toBe("");
  });

  it("proves every leaf, for every batch size, and nothing else", () => {
    for (let n = 1; n <= 9; n++) {
      const ls = leaves(n);
      const root = merkleRoot(ls);
      for (let i = 0; i < n; i++) expect(verifyMerkleProof(ls[i]!, root, merkleProof(ls, i))).toBe(true);
      if (n > 1) expect(verifyMerkleProof(ls[0]!, root, merkleProof(ls, 1))).toBe(false);
    }
  });

  it("builds a job's leaves from the chunk records the passport lists, in chunk order", () => {
    const w = (idx: number) => ({ idx, provider: "0xABC", resultHash: "ab".repeat(32), payTx: `0.0.1@1.${idx}` });
    expect(chunkLeaf("j", w(0))).toEqual({ job: "j", idx: 0, provider: "0xabc", resultHash: "ab".repeat(32), payTx: "0.0.1@1.0" });
    expect(chunkLeaves("j", [w(2), w(0), w(1)])).toEqual(chunkLeaves("j", [w(0), w(1), w(2)]));
  });
});

describe("PRNG spot checks", () => {
  it("picks non-canary chunks from the seed alone", () => {
    const seed = `0x${"7a".repeat(32)}`;
    const candidates = spotCandidates([0, 1, 2, 3, 4, 5, 6, 7], [1, 5]);
    expect(candidates).toEqual([0, 2, 3, 4, 6, 7]);
    const picks = spotPicks(seed, "job-a", candidates, 3);
    expect(picks).toHaveLength(3);
    expect(new Set(picks).size).toBe(3);
    expect(picks.every((i) => candidates.includes(i))).toBe(true);
    expect(spotPicks(seed, "job-a", [...candidates].reverse(), 3)).toEqual(picks);
    // The first picks don't depend on how many are drawn.
    expect(spotPicks(seed, "job-a", candidates, 1).every((i) => picks.includes(i))).toBe(true);
    expect(spotPicks(seed, "job-a", candidates, 99)).toEqual(candidates);
    expect(spotPicks(seed, "job-a", [], 2)).toEqual([]);
    expect(spotTag("job-a")).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("a job with a Merkle anchor and PRNG spot checks", () => {
  let s: Scenario;
  let passport: Passport;
  beforeAll(async () => {
    s = await runScenario({ basePort: 17500, chunkSize: 2, canaryRate: 0.5, spotChecks: 2 });
    passport = (await (await fetch(s.report.passport.url)).json()) as Passport;
  }, 180_000);
  afterAll(async () => {
    await s?.close();
  });

  it("anchors the finished chunks on HCS once, and the passport proves each one", async () => {
    const receipts = (await readReceipts({ mirrorUrl: `${s.devnet.url}/mirror`, hcsTopicId: "0.0.5005", jsonRpcUrl: "" }, 1000)).map((m) => m.receipt);
    const anchors = receipts.filter((r) => r.t === "anchor" && r.job === s.report.jobId);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({ schema: "hcs.merkleRootAnchor", hashAlg: "sha256", recordCount: passport.work.length, merkleRoot: passport.anchor!.merkleRoot });
    expect(JSON.stringify(anchors[0]).length).toBeLessThan(1024);
    expect(passportSchema.safeParse(passport).success).toBe(true);
    expect(passport.work.every((w) => w.merkleProof && w.merkleProof.length > 0)).toBe(true);
  });

  it("re-checks chunks picked by a seed drawn after the reveal, and the passport passes every check", async () => {
    const spot = passport.spot!;
    expect(spot.picks).toHaveLength(2);
    expect(spot.picks.some((i) => passport.canaries.revealed.includes(i))).toBe(false);
    expect(spot.checked.filter((c) => c.pass !== undefined)).toHaveLength(2);
    const checks = await verifyPassport(passport, { results: s.report.results, online: true });
    expect(checks.filter((c) => c.ok === false)).toEqual([]);
    const ok = (name: string) => expect(checks.find((c) => c.name === name)?.ok).toBe(true);
    ok("Merkle root over the chunks matches the anchor");
    ok("each chunk's Merkle proof leads to the anchored root");
    ok("HCS: the chunks' Merkle root is anchored (hcs.merkleRootAnchor)");
    ok("spot checks were picked by their PRNG seed");
    ok("HCS: spot-check receipt matches");
    ok("HCS: the number of spot checks was committed before work");
    ok("vault: the spot-check seed is the job's one PRNG draw");
    ok("the spot-check seed was drawn after the canary reveal");
  });

  it("catches a passport whose chunks or picks differ from what was anchored and drawn", async () => {
    const dropped = { ...passport, work: passport.work.slice(1) };
    const failed = (await verifyPassport(dropped as Passport, {})).filter((c) => c.ok === false).map((c) => c.name);
    expect(failed).toContain("Merkle root over the chunks matches the anchor");
    const other = passport.work.map((w) => w.idx).find((i) => !passport.canaries.revealed.includes(i) && !passport.spot!.picks.includes(i));
    if (other !== undefined) {
      const picked = { ...passport, spot: { ...passport.spot!, picks: [...passport.spot!.picks.slice(1), other].sort((a, b) => a - b) } };
      expect((await verifyPassport(picked as Passport, {})).filter((c) => c.ok === false).map((c) => c.name)).toContain("spot checks were picked by their PRNG seed");
    }
  });
});
