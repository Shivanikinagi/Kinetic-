import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPassport, type Passport } from "../src/agent/passport.js";
import { loadJob } from "../src/agent/report.js";
import { agreementProblems, makeAgreement } from "../src/core/agreement.js";
import { makeQuote, verifierFee } from "../src/core/quote.js";
import { readReceipts } from "../src/integrations/hcs.js";
import { heuristicRun } from "./support/heuristic.js";
import { runScenario, type Scenario } from "./support/scenario.js";

// Assurance tiers: the buyer picks how much verification a job gets, and pays for it.

const { task, items } = loadJob("data/classify-tickets.task.json", "data/tickets.jsonl");
const passportOf = async (s: Scenario) => (await (await fetch(s.report.passport.url)).json()) as Passport;
const failing = async (s: Scenario) => (await verifyPassport(await passportOf(s), { results: s.report.results, online: true })).filter((c) => c.ok === false);

describe("tier rules", () => {
  const policy = { canaryRate: 0.25, minAgreement: 0.8 };
  const budget = { asset: "0.0.0", maxSpend: "1000", maxPricePerChunk: "10" };

  it("prices verification by tier and pays for every copy at high assurance", () => {
    expect(verifierFee(10, 10_000n, 0, 0.25, "basic")).toBe(20_000n);
    expect(verifierFee(10, 10_000n, 0.25, 0.25, "standard")).toBe(100_000n);
    expect(verifierFee(10, 10_000n, 0.25, 0.25, "high")).toBe(150_000n);
    expect(verifierFee(10, 10_000n, 0.25, 0.25, "confidential")).toBe(125_000n);
    const standard = makeQuote({ chunks: 10, prices: [100n], feePerChunk: 0n, canaryRate: 0.25, protocolRate: 0.25 });
    const high = makeQuote({ chunks: 10, prices: [100n], feePerChunk: 0n, canaryRate: 0.25, protocolRate: 0.25, tier: "high" });
    expect(BigInt(high.work)).toBeGreaterThan(BigInt(standard.work) * 19n / 10n);
  });

  it("lets basic assurance run no canaries, and no other tier below the protocol's rate", () => {
    const basic = makeAgreement({ task, policy, budget, input: { tier: "basic" } });
    expect(basic).toMatchObject({ tier: "basic", canaryRate: 0 });
    expect(agreementProblems(basic, task, policy)).toEqual([]);
    expect(agreementProblems({ ...basic, tier: "standard" }, task, policy)).toEqual(["check rate must be between 0.25 and 1"]);
    expect(agreementProblems({ ...basic, tier: "premium" as never }, task, policy)[0]).toMatch(/unknown assurance tier/);
  });
});

describe("basic assurance", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await runScenario({ basePort: 11300, chunkSize: 2, canaryRate: 0.5, agreement: { tier: "basic" } });
  }, 90_000);
  afterAll(async () => {
    await s?.close();
  });

  it("checks only signatures and formats, charges a fifth of the fee, and says so", async () => {
    expect(s.report.canaries).toEqual([]);
    expect(s.report.verificationFeeTinybar).toBe(2_000n * BigInt(s.report.chunks));
    const p = await passportOf(s);
    expect(p.canaries.known).toBeUndefined();
    expect(p.summary).toMatchObject({ assurance: { tier: "basic", met: true }, correctness: { groundTruth: 0, formatOnly: s.report.chunks } });
    expect(p.summary!.verification).not.toBe("passed");
    expect(await failing(s)).toEqual([]);
  });
});

describe("high assurance", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await runScenario({ basePort: 11700, chunkSize: 2, canaryRate: 0.5, agreement: { tier: "high" } });
  }, 120_000);
  afterAll(async () => {
    await s?.close();
  });

  it("keeps a chunk only once two independent providers agree on it", async () => {
    expect(s.report.status).toBe("complete");
    expect(s.report.results).toEqual(heuristicRun(task, items).items);
    const p = await passportOf(s);
    expect(p.work.every((w) => w.redundancy && w.redundancy.with !== w.provider)).toBe(true);
    expect(p.work.every((w) => w.correctness?.methods.includes("redundant-agreement"))).toBe(true);
    const receipts = (await readReceipts({ mirrorUrl: `${s.devnet.url}/mirror`, hcsTopicId: "0.0.5005", jsonRpcUrl: "" }, 1000)).map((m) => m.receipt);
    expect(receipts.filter((r) => r.t === "redundant" && r.job === s.report.jobId)).toHaveLength(s.report.chunks);
    // Each chunk was paid at least twice.
    const payments = receipts.filter((r) => r.t === "chunk" && r.job === s.report.jobId).length;
    expect(payments).toBeGreaterThanOrEqual(2 * s.report.chunks);
    expect(p.summary!.assurance).toMatchObject({ tier: "high" });
    expect(p.summary!.assurance.shortfalls.filter((x) => /independent copy/.test(x))).toEqual([]);
    expect(await failing(s)).toEqual([]);
  });

  it("still slashes the lazy provider on known answers", () => {
    expect(s.report.providers.find((p) => p.name === "cheapo-3060")!.status).toBe("slashed");
  });
});

describe("confidential assurance", () => {
  let s: Scenario;
  beforeAll(async () => {
    // nimbus runs on a centralized 0G provider that relays to an outside cloud: TeeTLS, not TeeML.
    s = await runScenario({
      basePort: 12100,
      chunkSize: 2,
      canaryRate: 0.5,
      agreement: { tier: "confidential" },
      zeroG: { zgProviders: [{ model: "devnet-0gm" }, { model: "devnet-qwen", relays: "outside-cloud" }, { model: "devnet-gemma" }] },
    });
  }, 120_000);
  afterAll(async () => {
    await s?.close();
  });

  it("uses only TeeML-attested 0G nodes, and every kept chunk's attestation verified", async () => {
    expect(s.report.status).toBe("complete");
    const names = s.report.providers.map((p) => p.name);
    expect(names).not.toContain("nimbus-a100");
    expect(names).not.toContain("shoddy-1060");
    const p = await passportOf(s);
    expect(p.work.every((w) => w.authenticity?.guarantee === "TeeML" && w.authenticity.attestation === "verified" && w.authenticity.method === "0g-direct")).toBe(true);
    expect(p.summary!.authenticity.byGuarantee.TeeML).toBe(p.work.length);
    expect(p.summary!.assurance).toMatchObject({ tier: "confidential" });
    expect(p.summary!.assurance.shortfalls.filter((x) => /TeeML/.test(x))).toEqual([]);
    expect(await failing(s)).toEqual([]);
  });
});
