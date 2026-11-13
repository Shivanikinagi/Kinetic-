import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agreementHash } from "../src/core/agreement.js";
import { verifyPassport, type Passport } from "../src/agent/passport.js";
import { loadJob } from "../src/agent/report.js";
import { verifyReveal } from "../src/core/canary.js";
import { runScenario, type Scenario } from "./support/scenario.js";
import { readReceipts } from "../src/integrations/hcs.js";
import { heuristicRun } from "./support/heuristic.js";

// Full flow on the devnet. A high canary rate makes catching the lazy provider all but
// certain (it fails every canary it gets).

let s: Scenario;

beforeAll(async () => {
  s = await runScenario({ basePort: 4900, chunkSize: 2, canaryRate: 0.6 });
  // Generous: other full-system suites run alongside it.
}, 120_000);

afterAll(async () => {
  await s?.close();
});

describe("end to end on devnet", () => {
  it("completes the job with every result matching the reference", () => {
    const { task, items } = loadJob("data/classify-tickets.task.json", "data/tickets.jsonl");
    expect(s.report.status).toBe("complete");
    expect(s.report.completed).toBe(s.report.chunks);
    expect(s.report.results).toEqual(heuristicRun(task, items).items);
  });

  it("logs every accepted chunk with its paid provider, check and speed", () => {
    const log = s.report.chunkLog;
    expect(log.map((c) => c.idx).sort((a, b) => a - b)).toEqual([...Array(s.report.chunks).keys()]);
    expect(log.flatMap((c) => c.itemIds).sort()).toEqual(s.report.results.map((r) => r.id).sort());
    for (const c of log) {
      // Kept work only: never the slashed provider (its chunks were rerouted) or the unqualified one.
      // flicker-t4 answers honestly until it goes offline, so its accepted chunks stay.
      expect(["atlas-4090", "nimbus-a100", "flicker-t4"]).toContain(c.name);
      expect(c.payTx).toBeTruthy();
      expect(BigInt(c.amount)).toBeGreaterThan(0n);
      expect(c.roundTripMs).toBeGreaterThanOrEqual(0);
      // The heuristic backend reports no tokens, so the node times the call itself.
      expect(c.usage?.latencyMs).toBeGreaterThanOrEqual(0);
      expect(c.usage?.completionTokens).toBeUndefined();
    }
  });

  it("slashes the lazy provider and refunds everything the buyer paid it", () => {
    const lazy = s.report.providers.find((p) => p.name === "cheapo-3060")!;
    expect(lazy.status).toBe("slashed");
    expect(lazy.kept).toBe(0);
    expect(lazy.refundTinybar).toBe(lazy.paidTinybar);
    expect(s.report.canaryFailures).toBeGreaterThanOrEqual(3);
  });

  it("keeps a lazy provider out with a known-answer qualification before any paid work", () => {
    const shoddy = s.report.providers.find((p) => p.name === "shoddy-1060")!;
    expect(shoddy.status).toBe("unqualified");
    expect(shoddy.qualification?.admitted).toBe(false);
    expect(shoddy.paidTinybar).toBe(0n);
    const admitted = s.report.providers.filter((p) => p.qualification?.admitted).map((p) => p.name).sort();
    expect(admitted).toEqual(["atlas-4090", "cheapo-3060", "flicker-t4", "nimbus-a100"]);
  });

  it("routes around the provider that goes offline and never slashes honest ones", () => {
    const by = Object.fromEntries(s.report.providers.map((p) => [p.name, p]));
    expect(by["flicker-t4"].status).toBe("offline");
    expect(by["atlas-4090"].status).toBe("active");
    expect(by["nimbus-a100"].status).toBe("active");
  });

  it("shows which providers are adversarial test providers, without routing on it", () => {
    const by = Object.fromEntries(s.report.providers.map((p) => [p.name, p]));
    expect(by["atlas-4090"].adversarial).toBeUndefined();
    expect(by["cheapo-3060"].adversarial).toBe("stops calling its model after 1 chunk");
    expect(by["shoddy-1060"].adversarial).toBe("never calls its model");
    // The label doesn't keep it out: it was admitted and paid like anyone else, then caught.
    expect(by["cheapo-3060"].paidTinybar).toBeGreaterThan(0n);
  });

  it("commits a firm quote before any work and never spends past it", () => {
    const q = s.report.agreement.quote!;
    expect(BigInt(q.total)).toBe(BigInt(q.work) + BigInt(q.fee));
    expect(BigInt(q.fee)).toBe(s.report.verificationFeeTinybar);
    expect(s.report.paidTinybar + s.report.verificationFeeTinybar <= BigInt(q.total)).toBe(true);
    expect(s.report.outcome.notes.some((n) => n.includes("quoted"))).toBe(true);
  });

  it("charges the buyer only paid minus refunded, plus the verifier's fee", () => {
    expect(s.report.verificationFeeTinybar).toBe(10_000n * BigInt(s.report.chunks));
    const net = s.report.paidTinybar - s.report.refundedTinybar + s.report.verificationFeeTinybar;
    expect(s.balances.buyerBefore - s.balances.buyerAfter).toBe(net);
  });

  it("stores a Compute Passport on 0G Storage, co-signed by the verifier, that passes every check", async () => {
    expect(s.report.auditRef).toMatch(/^0x[0-9a-f]{64}$/);
    expect(s.report.passport.attested).toBe(true);
    const passport = (await (await fetch(s.report.passport.url)).json()) as Passport;
    expect(passport).toMatchObject({ kind: "kinetic.passport.v2", jobId: s.report.jobId, completed: s.report.chunks });
    expect(passport.canaries.commitment).toBe(s.report.commitment);
    expect(passport.work).toHaveLength(s.report.chunks);
    expect(passport.coverage.verified).toBeGreaterThan(0);
    // Offline and online: signatures, hashes, HCS receipts, mirror-node payments, vault slashes.
    const checks = await verifyPassport(passport, { results: s.report.results, online: true });
    expect(checks.filter((c) => c.ok === false)).toEqual([]);
    expect(checks.filter((c) => c.ok === true).length).toBeGreaterThanOrEqual(14);
    // A changed result no longer matches what the provider signed.
    const tampered = s.report.results.map((r, i) => (i === 0 ? { ...r, label: r.label === "bug" ? "billing" : "bug" } : r));
    const bad = await verifyPassport(passport, { results: tampered });
    expect(bad.filter((c) => c.ok === false).map((c) => c.name)).toContain("results match each chunk's signed hash");
  });

  it("leaves a verifiable audit trail on HCS", async () => {
    const receipts = (await readReceipts({ mirrorUrl: `${s.devnet.url}/mirror`, hcsTopicId: "0.0.5005", jsonRpcUrl: "" }, 1000)).map((m) => m.receipt);
    const job = receipts.find((r) => r.t === "job" && r.job === s.report.jobId);
    const reveal = receipts.find((r) => r.t === "reveal" && r.job === s.report.jobId);
    expect(job && reveal).toBeTruthy();
    if (job?.t === "job" && reveal?.t === "reveal") {
      expect(verifyReveal(s.report.jobId, reveal.canaries, reveal.salt, job.commitment)).toBe(true);
    }
    expect(receipts.some((r) => r.t === "slash")).toBe(true);
  });
});

describe("quarantine when a provider fails canaries but is not slashed", () => {
  let q: Scenario;

  beforeAll(async () => {
    // A slash threshold no one reaches, so only quarantine can protect the results.
    q = await runScenario({ basePort: 5300, chunkSize: 2, canaryRate: 0.5, failLimit: 99 });
  }, 120_000);

  afterAll(async () => {
    await q?.close();
  });

  it("re-runs the lazy provider's unverified chunks so every result is still correct", () => {
    const { task, items } = loadJob("data/classify-tickets.task.json", "data/tickets.jsonl");
    const lazy = q.report.providers.find((p) => p.name === "cheapo-3060")!;
    expect(lazy.status).toBe("quarantined");
    // Its first chunk is honest (degrade-after:1); it's kept only when it was a canary that passed.
    expect(lazy.kept).toBeLessThanOrEqual(1);
    expect(lazy.refundTinybar).toBe(0n);
    // Known answers in every chunk usually catch it before any of its work is accepted; whatever
    // was accepted unchecked is re-run. Either way it failed checks and kept nothing it faked.
    expect(q.report.canaryFailures + q.report.rechecked).toBeGreaterThan(0);
    expect(q.report.status).toBe("complete");
    expect(q.report.results).toEqual(heuristicRun(task, items).items);
  });
});

describe("a job agreement set by the buyer", () => {
  let g: Scenario;
  const gold = readFileSync("data/gold-tickets.jsonl", "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

  beforeAll(async () => {
    // Stricter than the network (pass mark 90%, 70% of chunks checked vs 60%), and providers are
    // admitted on the buyer's own labelled examples.
    g = await runScenario({ basePort: 6500, chunkSize: 2, canaryRate: 0.6, agreement: { canaryRate: 0.7, minAgreement: 0.9, goldSet: gold, minAccuracy: 0.9, deadlineSeconds: 600 } });
  }, 90_000);

  afterAll(async () => {
    await g?.close();
  });

  it("commits to the rules on HCS before work and meets them", async () => {
    const { agreement, outcome } = g.report;
    expect(agreement).toMatchObject({ canaryRate: 0.7, minAgreement: 0.9, admission: { source: "buyer", size: gold.length, minAccuracy: 0.9 } });
    expect(JSON.stringify(agreement)).not.toContain(gold[0].text);
    expect(outcome.met).toBe(true);
    expect(g.report.status).toBe("complete");
    const receipts = (await readReceipts({ mirrorUrl: `${g.devnet.url}/mirror`, hcsTopicId: "0.0.5005", jsonRpcUrl: "" }, 1000)).map((m) => m.receipt);
    const job = receipts.find((r) => r.t === "job" && r.job === g.report.jobId);
    expect(job?.t === "job" && job.agreement).toBe(agreementHash(agreement));
    // Admission used the buyer's examples for this job.
    expect(receipts.some((r) => r.t === "qualify" && r.job === g.report.jobId)).toBe(true);
  });

  it("admits on the buyer's examples and charges for the extra checks", () => {
    const shoddy = g.report.providers.find((p) => p.name === "shoddy-1060")!;
    expect(shoddy.status).toBe("unqualified");
    expect(g.report.canaries.length).toBe(Math.round(g.report.chunks * 0.7));
    expect(g.report.verificationFeeTinybar).toBe(BigInt(Math.ceil(10_000 * g.report.chunks * (0.7 / 0.6))));
  });

  it("produces a passport that passes every check, the agreement included", async () => {
    const passport = (await (await fetch(g.report.passport.url)).json()) as Passport;
    const checks = await verifyPassport(passport, { results: g.report.results, online: true });
    expect(checks.filter((c) => c.ok === false)).toEqual([]);
    expect(checks.find((c) => c.name === "HCS: agreement matches what was committed before work")?.ok).toBe(true);
    expect(checks.find((c) => c.name === "verified chunks meet the agreed pass mark")?.ok).toBe(true);
  });
});

describe("a deadline that passes before the work is done", () => {
  let d: Scenario;

  beforeAll(async () => {
    d = await runScenario({ basePort: 7300, chunkSize: 2, canaryRate: 0.5, agreement: { deadlineSeconds: 0.5 } });
  }, 90_000);

  afterAll(async () => {
    await d?.close();
  });

  it("stops paid work, says the agreement wasn't met, and still issues a verifiable passport", async () => {
    expect(d.report.status).toBe("incomplete");
    expect(d.report.outcome.met).toBe(false);
    expect(d.report.outcome.notes).toContain("the deadline passed");
    const passport = (await (await fetch(d.report.passport.url)).json()) as Passport;
    expect(passport.outcome.met).toBe(false);
    const checks = await verifyPassport(passport, { results: d.report.results, online: true });
    expect(checks.filter((c) => c.ok === false)).toEqual([]);
  });
});

describe("a provider that asked for its bond back", () => {
  let w: Scenario;

  beforeAll(async () => {
    w = await runScenario({ basePort: 7700, chunkSize: 2, canaryRate: 0.5, withdrawing: ["atlas-4090"] });
  }, 90_000);

  afterAll(async () => {
    await w?.close();
  });

  it("gets no work, because it could take the bond out ahead of a slash", () => {
    expect(w.report.providers.find((p) => p.name === "atlas-4090")).toBeUndefined();
    expect(w.report.status).toBe("complete");
  });
});

describe("provider choice with reserves", () => {
  let r: Scenario;

  beforeAll(async () => {
    // Only two providers work at once. With no history yet, the cheapest admitted two go first:
    // cheapo-3060 (gets slashed) and flicker-t4 (crashes). Reserves must step in to finish.
    r = await runScenario({ basePort: 6100, chunkSize: 2, canaryRate: 0.6, choice: { strategy: "balanced", maxProviders: 2 } });
  }, 90_000);

  afterAll(async () => {
    await r?.close();
  });

  it("starts with the best-ranked providers and promotes reserves when they drop out", () => {
    const { task, items } = loadJob("data/classify-tickets.task.json", "data/tickets.jsonl");
    const by = Object.fromEntries(r.report.providers.map((p) => [p.name, p]));
    expect(r.report.strategy).toBe("balanced");
    expect(by["cheapo-3060"].promoted).toBeUndefined();
    expect(by["flicker-t4"].promoted).toBeUndefined();
    expect(by["cheapo-3060"].status).toBe("slashed");
    expect(by["atlas-4090"].promoted || by["nimbus-a100"].promoted).toBe(true);
    expect(by["cheapo-3060"].rank!.score).toBeGreaterThan(by["nimbus-a100"].rank!.score);
    expect(r.report.status).toBe("complete");
    expect(r.report.results).toEqual(heuristicRun(task, items).items);
  });
});
