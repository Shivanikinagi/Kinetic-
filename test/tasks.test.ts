import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPassport, type Passport } from "../src/agent/passport.js";
import { loadJob } from "../src/agent/report.js";
import { presets } from "../src/agent/service.js";
import { readReceipts } from "../src/integrations/hcs.js";
import { goldFor, loadGoldSets, plantingPool, truthOf } from "../src/verifier/known.js";
import { heuristicRun } from "./support/heuristic.js";
import { runScenario, type Scenario } from "./support/scenario.js";

// Known answers for every task with a labelled set, not just ticket classification: the
// verifier plants from the set whose task the job is, and admits providers on that task only.

const sets = loadGoldSets();

describe("labelled sets for ten tasks", () => {
  it("loads one set per task, each fitting its own task and no other", () => {
    expect(sets.length).toBe(10);
    const kinds = new Set(sets.map((s) => s.task.kind));
    expect([...kinds].sort()).toEqual(["classify", "extract", "tag"]);
    for (const s of sets) {
      expect(goldFor(sets, s.task)).toBe(s);
      expect(s.items.length).toBeGreaterThanOrEqual(12);
      expect(plantingPool(s).items.length).toBeGreaterThan(0);
    }
    const presetIds = presets().map((p) => p.id);
    for (const id of ["sentiment", "language", "news-topic", "spam", "intent", "animal-class", "ticket-tags", "ticket-fields", "invoice-fields"]) expect(presetIds).toContain(id);
  });

  it("knows the true output for every kind of task", () => {
    const tags = goldFor(sets, loadJob("data/tasks/ticket-tags").task)!;
    expect(truthOf(tags.task, tags.items[8], "x")).toEqual({ id: "x", tags: ["login", "mobile"] });
    const invoice = goldFor(sets, loadJob("data/tasks/invoice-fields").task)!;
    expect(truthOf(invoice.task, invoice.items[3], "y")).toEqual({ id: "y", fields: { invoice_number: "INV-30001", due_date: null } });
  });
});

for (const [name, port] of [
  ["invoice-fields", 12500],
  ["ticket-fields", 12900],
] as const) {
  describe(`a ${name} job with known answers`, () => {
    let s: Scenario;
    beforeAll(async () => {
      s = await runScenario({ basePort: port, chunkSize: 2, canaryRate: 0.5, taskPath: `data/tasks/${name}/task.json`, itemsPath: `data/tasks/${name}/items.jsonl` });
    }, 90_000);
    afterAll(async () => {
      await s?.close();
    });

    it("plants that task's known answers, keeps them out of the results, and the passport checks out", async () => {
      const { task, items } = loadJob(`data/tasks/${name}`);
      expect(s.report.status).toBe("complete");
      expect(s.report.results).toEqual(heuristicRun(task, items).items);
      const receipts = (await readReceipts({ mirrorUrl: `${s.devnet.url}/mirror`, hcsTopicId: "0.0.5005", jsonRpcUrl: "" }, 1000)).map((m) => m.receipt);
      expect(receipts.filter((r) => r.t === "known" && r.job === s.report.jobId).length).toBeGreaterThanOrEqual(s.report.chunks);
      const passport = (await (await fetch(s.report.passport.url)).json()) as Passport;
      expect(passport.canaries.known!.placements).toHaveLength(s.report.chunks);
      expect(passport.summary!.assurance.met).toBe(true);
      const checks = await verifyPassport(passport, { results: s.report.results, online: true });
      expect(checks.filter((c) => c.ok === false)).toEqual([]);
    });

    it("admits on this task's own known answers", () => {
      const shoddy = s.report.providers.find((p) => p.name === "shoddy-1060")!;
      expect(shoddy.status).toBe("unqualified");
      expect(shoddy.qualification?.skipped).toBeFalsy();
    });
  });
}
