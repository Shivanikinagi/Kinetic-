import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BuyerAgent } from "../src/agent/buyer.js";
import { verifyPassport, type Passport } from "../src/agent/passport.js";
import { loadJob } from "../src/agent/report.js";
import { readReceipts } from "../src/integrations/hcs.js";
import { heuristicRun } from "./support/heuristic.js";
import { runScenario, type Scenario } from "./support/scenario.js";

// Slashing by a quorum of verifiers, the dispute window, and the live check record on Arkiv.
// The lazy provider (cheapo-3060) fails every canary after its first chunk.

const receiptsOf = async (s: Scenario) =>
  (await readReceipts({ mirrorUrl: `${s.devnet.url}/mirror`, hcsTopicId: "0.0.5005", jsonRpcUrl: "" }, 1000)).map((m) => m.receipt).filter((r) => !("job" in r) || r.job === s.report.jobId);
const vault = async <T>(s: Scenario, path: string) => (await (await fetch(`${s.devnet.url}/devnet/vault/${path}`)).json()) as T;
const passportChecks = async (s: Scenario) => {
  const passport = (await (await fetch(s.report.passport.url)).json()) as Passport;
  return verifyPassport(passport, { results: s.report.results, online: true });
};

describe("a slash needs 2 of 3 verifiers, each re-checking the evidence", () => {
  let s: Scenario;

  beforeAll(async () => {
    s = await runScenario({ basePort: 8500, chunkSize: 2, canaryRate: 0.6, quorum: { cosigners: 2, threshold: 2 } });
  }, 90_000);
  afterAll(async () => {
    await s?.close();
  });

  it("slashes with a quorum of signatures, refunds the buyer and burns the rest of the bond", async () => {
    const cheapo = s.report.providers.find((p) => p.name === "cheapo-3060")!;
    expect(cheapo.status).toBe("slashed");
    expect(cheapo.slashStatus).toBe("executed");
    expect(cheapo.slashSigners!.length).toBeGreaterThanOrEqual(2);
    expect(cheapo.refundTinybar).toBe(cheapo.paidTinybar);
    expect(cheapo.burnedTinybar).toBe(100_000_000n - cheapo.paidTinybar);
    expect(await vault(s, `bonds/${cheapo.provider}`)).toMatchObject({ amount: "0", slashed: true, pending: 0 });
    const net = s.report.paidTinybar - s.report.refundedTinybar + s.report.verificationFeeTinybar;
    expect(s.balances.buyerBefore - s.balances.buyerAfter).toBe(net);
  });

  it("records the proposal and its settlement on HCS, and the passport checks both", async () => {
    const receipts = await receiptsOf(s);
    const slash = receipts.find((r) => r.t === "slash");
    const settle = receipts.find((r) => r.t === "settle");
    expect(slash?.t === "slash" && slash.signers!.length).toBeGreaterThanOrEqual(2);
    expect(settle?.t === "settle" && settle.outcome).toBe("executed");
    const checks = await passportChecks(s);
    expect(checks.filter((c) => c.ok === false)).toEqual([]);
    expect(checks.find((c) => c.name === "vault: every slash stands where the passport says")?.ok).toBe(true);
    expect(checks.find((c) => c.name === "vault: the co-signer is one of the vault's verifiers")?.ok).toBe(true);
  });

  it("writes every check as an expiring Arkiv entity, and the next job ranks on them", async () => {
    const status = (await (await fetch(`${s.verifierUrl}/status`)).json()) as { verifier: string };
    const checks = await s.buyerSvc.arkiv.query("check", {}, { owner: status.verifier, limit: 1000 });
    // The lazy provider is caught on the known answers planted in its chunks.
    expect(checks.some((c) => c.attrs.src === "known" && Number(c.attrs.pass) === 0)).toBe(true);
    expect(checks.some((c) => c.attrs.src === "admission")).toBe(true);
    const { task, items } = loadJob("data/classify-tickets.task.json", "data/tickets.jsonl");
    const agent = new BuyerAgent(s.buyerSvc, s.verifierUrl, { maxPricePerChunk: 500_000n, maxJobSpend: 50_000_000n });
    const offers = await agent.discover(task.kind);
    const atlas = offers.find((o) => o.name === "atlas-4090")!;
    expect(atlas.rank?.proof).toBe("active");
    // The slashed provider is out entirely; the one that never passed has no proof.
    expect(offers.find((o) => o.name === "cheapo-3060")).toBeUndefined();
    expect(offers.find((o) => o.name === "shoddy-1060")?.rank?.proof).toBe("unproven");
    expect(items.length).toBeGreaterThan(0);
  });
});

describe("cosigners that don't confirm the failures block the slash", () => {
  let s: Scenario;

  beforeAll(async () => {
    s = await runScenario({ basePort: 8900, chunkSize: 2, canaryRate: 0.6, quorum: { cosigners: 2, threshold: 2, lenient: 2 } });
  }, 90_000);
  afterAll(async () => {
    await s?.close();
  });

  it("leaves the bond alone, logs the refusal, and still delivers correct results by quarantine", async () => {
    const { task, items } = loadJob("data/classify-tickets.task.json", "data/tickets.jsonl");
    const cheapo = s.report.providers.find((p) => p.name === "cheapo-3060")!;
    expect(cheapo.status).toBe("quarantined");
    expect(cheapo.refundTinybar).toBe(0n);
    expect(await vault(s, `bonds/${cheapo.provider}`)).toMatchObject({ amount: "100000000", slashed: false, pending: 0 });
    const refused = (await receiptsOf(s)).find((r) => r.t === "slash-refused");
    expect(refused?.t === "slash-refused" && refused.need).toBe(2);
    expect((await receiptsOf(s)).some((r) => r.t === "slash")).toBe(false);
    expect(s.report.results).toEqual(heuristicRun(task, items).items);
  });
});

describe("a disputed slash the verifiers uphold", () => {
  let s: Scenario;

  beforeAll(async () => {
    s = await runScenario({ basePort: 9300, chunkSize: 2, canaryRate: 0.6, quorum: { cosigners: 2, threshold: 2 }, disputeWindowSeconds: 3, disputing: ["cheapo-3060"] });
  }, 120_000);
  afterAll(async () => {
    await s?.close();
  });

  it("re-checks it with every verifier, executes it, and gives the buyer the challenge bond too", async () => {
    const cheapo = s.report.providers.find((p) => p.name === "cheapo-3060")!;
    expect(cheapo.slashStatus).toBe("executed");
    expect(cheapo.refundTinybar).toBe(cheapo.paidTinybar);
    const dispute = (await receiptsOf(s)).find((r) => r.t === "dispute");
    expect(dispute?.t === "dispute" && dispute.upheld).toBe(3);
    const challenge = 10_000_000n;
    const net = s.report.paidTinybar - s.report.refundedTinybar + s.report.verificationFeeTinybar;
    expect(s.balances.buyerBefore - s.balances.buyerAfter).toBe(net - challenge);
    expect((await passportChecks(s)).filter((c) => c.ok === false)).toEqual([]);
  });
});

describe("a disputed slash the verifiers can't agree on", () => {
  let s: Scenario;

  beforeAll(async () => {
    // The lead alone may slash (threshold 1), but deciding a dispute takes all three, and two
    // cosigners never confirm anything: the dispute stalls and is cancelled at the timeout.
    s = await runScenario({
      basePort: 9700,
      chunkSize: 2,
      canaryRate: 0.6,
      quorum: { cosigners: 2, threshold: 1, lenient: 2 },
      disputeWindowSeconds: 3,
      resolveTimeoutSeconds: 2,
      disputing: ["cheapo-3060"],
    });
  }, 120_000);
  afterAll(async () => {
    await s?.close();
  });

  it("is cancelled in the provider's favour: no refund, bond kept, not marked slashed", async () => {
    const cheapo = s.report.providers.find((p) => p.name === "cheapo-3060")!;
    expect(cheapo.slashStatus).toBe("cancelled");
    expect(cheapo.refundTinybar).toBe(0n);
    expect(await vault(s, `bonds/${cheapo.provider}`)).toMatchObject({ amount: "100000000", slashed: false, pending: 0 });
    const dispute = (await receiptsOf(s)).find((r) => r.t === "dispute");
    expect(dispute?.t === "dispute" && [dispute.upheld, dispute.overturned]).toEqual([1, 2]);
    // Its work was still rerouted, so the buyer's results are right.
    const { task, items } = loadJob("data/classify-tickets.task.json", "data/tickets.jsonl");
    expect(s.report.results).toEqual(heuristicRun(task, items).items);
    expect((await passportChecks(s)).filter((c) => c.ok === false)).toEqual([]);
  });
});
