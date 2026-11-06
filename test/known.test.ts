import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPassport, type Passport } from "../src/agent/passport.js";
import { loadJob } from "../src/agent/report.js";
import { readReceipts } from "../src/integrations/hcs.js";
import { admissionPool, commitKnown, goldFits, loadGold, lookalikeId, plant, plantingPool, scoreKnown, verifyKnownReveal } from "../src/verifier/known.js";
import { heuristicRun } from "./support/heuristic.js";
import { runScenario, type Scenario } from "./support/scenario.js";

// Ground-truth canaries: a known-answer item planted in every chunk. Misses slash; disagreeing
// with the 0G reference model does not.

const gold = loadGold()!;
const { task, items } = loadJob("data/classify-tickets.task.json", "data/tickets.jsonl");

describe("planting known answers", () => {
  it("splits the labelled set into disjoint admission and planting halves", () => {
    const a = admissionPool(gold).items.map((g) => g.text);
    const p = plantingPool(gold).items.map((g) => g.text);
    expect(a.length + p.length).toBe(gold.items.length);
    expect(a.filter((t) => p.includes(t))).toEqual([]);
    expect(a.length).toBeGreaterThan(5);
    expect(p.length).toBeGreaterThan(5);
    expect(goldFits(gold, task)).toBe(true);
    expect(goldFits(gold, { ...task, labels: task.labels!.slice(1) })).toBe(false);
  });

  it("plants one item per chunk under an id that looks like the buyer's, and commits to where", () => {
    const chunks = [items.slice(0, 3), items.slice(3, 6), items.slice(6, 8)].map((part, idx) => ({ idx, items: part }));
    const { chunks: out, truth, plan } = plant("job-x", task, plantingPool(gold), chunks);
    for (const [i, c] of out.entries()) {
      expect(c.items).toHaveLength(chunks[i].items.length + 1);
      const extra = c.items.filter((it) => !chunks[i].items.some((o) => o.id === it.id));
      expect(extra).toHaveLength(1);
      expect(extra[0].id).toMatch(/^t\d{3}$/);
      expect(plantingPool(gold).items.some((g) => g.text === extra[0].text)).toBe(true);
      expect(plan.placements[i]).toEqual({ idx: i, ids: [extra[0].id] });
      expect(truth.get(extra[0].id)?.label).toBe(gold.items.find((g) => g.text === extra[0].text)!.label);
    }
    expect(verifyKnownReveal("job-x", plan.placements, plan.salt, plan.commitment)).toBe(true);
    expect(verifyKnownReveal("job-x", plan.placements.slice(1), plan.salt, plan.commitment)).toBe(false);
    expect(commitKnown("job-y", plan.placements, plan.salt)).not.toBe(plan.commitment);
  });

  it("never reuses an id and scores exactly", () => {
    const taken = new Set(Array.from({ length: 990 }, (_, i) => `t${String(i).padStart(3, "0")}`));
    const id = lookalikeId(["t001"], taken);
    expect(taken.has(id)).toBe(false);
    expect(scoreKnown(task, [{ id: "a", label: "bug" }], [{ id: "a", label: "Bug " }])).toEqual({ items: 1, correct: 1, pass: true });
    expect(scoreKnown(task, [{ id: "a", label: "bug" }], [{ id: "a", label: "billing" }]).pass).toBe(false);
    expect(scoreKnown(task, [{ id: "a", label: "bug" }], []).pass).toBe(false);
  });
});

describe("a job with known answers in every chunk", () => {
  let s: Scenario;

  beforeAll(async () => {
    s = await runScenario({ basePort: 10100, chunkSize: 2, canaryRate: 0.5 });
  }, 90_000);
  afterAll(async () => {
    await s?.close();
  });

  it("slashes the lazy provider on missed known answers and keeps them out of the results", async () => {
    expect(s.report.status).toBe("complete");
    expect(s.report.results).toEqual(heuristicRun(task, items).items);
    expect(s.report.providers.find((p) => p.name === "cheapo-3060")!.status).toBe("slashed");
    const receipts = (await readReceipts({ mirrorUrl: `${s.devnet.url}/mirror`, hcsTopicId: "0.0.5005", jsonRpcUrl: "" }, 1000)).map((m) => m.receipt);
    const job = receipts.find((r) => r.t === "job" && r.job === s.report.jobId);
    expect(job?.t === "job" && job.known).toMatch(/^[0-9a-f]{64}$/);
    const known = receipts.filter((r) => r.t === "known" && r.job === s.report.jobId);
    expect(known.some((r) => r.t === "known" && !r.pass)).toBe(true);
    const slash = receipts.find((r) => r.t === "slash" && r.job === s.report.jobId);
    expect(slash).toBeTruthy();
  });

  it("issues a passport that reveals where known answers were, and passes every check", async () => {
    const passport = (await (await fetch(s.report.passport.url)).json()) as Passport;
    expect(passport.canaries.known!.placements).toHaveLength(s.report.chunks);
    expect(passport.coverage.known).toBe(s.report.chunks);
    expect(passport.work.every((w) => w.planted?.length === 1 && w.known?.correct === 1)).toBe(true);
    // The passport never carries a planted item's text or true label.
    expect(JSON.stringify(passport)).not.toContain(gold.items[0].text);
    const checks = await verifyPassport(passport, { results: s.report.results, online: true });
    expect(checks.filter((c) => c.ok === false)).toEqual([]);
    expect(checks.find((c) => c.name === "every chunk's known answers were planted where committed, and passed")?.ok).toBe(true);
    expect(checks.find((c) => c.name === "HCS: known answers committed before work and revealed after")?.ok).toBe(true);
    expect(checks.find((c) => c.name === "results match each chunk's signed hash")?.ok).toBe(true);
  });
});

describe("honest providers that disagree with the 0G reference model", () => {
  let s: Scenario;

  beforeAll(async () => {
    // The reference model disagrees with every honest answer; the known answers say they're right.
    s = await runScenario({ basePort: 10500, chunkSize: 2, canaryRate: 0.5, referenceDisagrees: true });
  }, 90_000);
  afterAll(async () => {
    await s?.close();
  });

  it("are never slashed for it, while the lazy provider still is", async () => {
    const by = Object.fromEntries(s.report.providers.map((p) => [p.name, p]));
    expect(by["atlas-4090"].status).not.toBe("slashed");
    expect(by["nimbus-a100"].status).not.toBe("slashed");
    expect(by["cheapo-3060"].status).toBe("slashed");
    for (const name of ["atlas-4090", "nimbus-a100"]) {
      const bond = (await (await fetch(`${s.devnet.url}/devnet/vault/bonds/${by[name].provider}`)).json()) as { slashed: boolean; amount: string };
      expect(bond).toMatchObject({ slashed: false, amount: "100000000" });
    }
  });
});

describe("the old rule, where disagreeing with the model slashes", () => {
  let s: Scenario;

  beforeAll(async () => {
    s = await runScenario({ basePort: 10900, chunkSize: 2, canaryRate: 1, referenceDisagrees: true, plantKnown: false, modelSlashes: true });
  }, 90_000);
  afterAll(async () => {
    await s?.close();
  });

  it("slashes honest providers on model disagreement alone: why it is off by default", () => {
    const honest = s.report.providers.filter((p) => p.name === "atlas-4090" || p.name === "nimbus-a100");
    expect(honest.some((p) => p.status === "slashed")).toBe(true);
  });
});
