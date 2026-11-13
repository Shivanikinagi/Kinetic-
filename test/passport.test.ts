import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import type { ProviderReport } from "../src/agent/buyer.js";
import { buildPassportBody, signPassport, verifyPassport, type Passport, type PassportWork } from "../src/agent/passport.js";
import { agreementProblems, goldHash, makeAgreement } from "../src/core/agreement.js";
import { commitCanaries } from "../src/core/canary.js";
import type { TaskSpec } from "../src/types.js";
import { canonicalJson, sha256Hex } from "../src/util/crypto.js";
import { signResult } from "../src/util/sign.js";

// A two-chunk job built by hand: chunk 0 is a canary that passed, chunk 1 passed the format check.

const buyer = privateKeyToAccount(generatePrivateKey());
const verifier = privateKeyToAccount(generatePrivateKey());
const provider = privateKeyToAccount(generatePrivateKey());
const jobId = "job-test-1";
const chunkResults = [{ items: [{ id: "t1", label: "billing" }, { id: "t2", label: "bug" }] }, { items: [{ id: "t3", label: "account" }] }];
const results = chunkResults.flatMap((r) => r.items);
const task: TaskSpec = { kind: "classify", instructions: "", labels: [{ name: "billing" }, { name: "bug" }, { name: "account" }] };

async function makePassport(): Promise<Passport> {
  const work: PassportWork[] = [];
  for (const [idx, result] of chunkResults.entries()) {
    const resultHash = sha256Hex(canonicalJson(result));
    work.push({ idx, items: result.items.length, provider: provider.address.toLowerCase(), resultHash, signature: await signResult(provider, jobId, idx, resultHash), payTx: `tx-${idx}`, amount: "100000", check: idx === 0 ? "verified" : "format" });
  }
  const report: ProviderReport = { name: "atlas", provider: provider.address.toLowerCase(), priceTinybar: 100_000n, status: "active", served: 2, kept: 2, paidTinybar: 200_000n, refundTinybar: 0n, undeliveredTinybar: 0n };
  const body = buildPassportBody({
    jobId,
    network: "devnet",
    buyer: { address: buyer.address.toLowerCase() },
    task,
    items: 3,
    chunkSize: 2,
    chunks: 2,
    results,
    work,
    canaries: {
      commitment: commitCanaries(jobId, [0], "salt"),
      revealed: [0],
      salt: "salt",
      checked: [{ idx: 0, provider: provider.address.toLowerCase(), agreement: 1, pass: true, zeroGRequest: "req-0", model: "ref" }],
    },
    unscoredCanaries: 0,
    policy: { canaryRate: 0.25, minAgreement: 0.8, window: 10, failLimit: 3 },
    payment: { id: "0.0.0", symbol: "HBAR", decimals: 8 },
    verificationFee: { tinybar: "20000" },
    providers: [report],
    references: { x402Network: "kinetic:devnet", hcsTopic: "0.0.5005", mirrorUrl: "", storageGateway: "" },
    agreement: makeAgreement({ task, policy: { canaryRate: 0.25, minAgreement: 0.8 }, budget: { asset: "0.0.0", maxSpend: "1000000", maxPricePerChunk: "100000" }, input: { minAgreement: 0.9 } }),
    outcome: { met: true, notes: ["all 2 chunks finished within the budget"] },
  });
  return { ...body, attestations: { buyer: await signPassport(buyer, body), verifier: await signPassport(verifier, body) } };
}

const failing = async (p: Passport, opts = {}) => (await verifyPassport(p, { results, ...opts })).filter((c) => c.ok === false).map((c) => c.name);

describe("Compute Passport", () => {
  it("passes every offline check when nothing was changed", async () => {
    const p = await makePassport();
    expect(await failing(p)).toEqual([]);
    expect(p.coverage).toEqual({ verified: 1, formatOnly: 1, share: 0.5 });
    expect(p.limitations[0]).toMatch(/1 of 2 chunks/);
  });

  it("detects an edited passport", async () => {
    const p = await makePassport();
    const edited = { ...p, coverage: { ...p.coverage, verified: 2, formatOnly: 0, share: 1 } };
    expect(await failing(edited)).toEqual(expect.arrayContaining(["signed by the buyer", "co-signed by the verifier", "coverage numbers add up"]));
  });

  it("detects results that differ from what the provider signed", async () => {
    const p = await makePassport();
    const tampered = results.map((r) => (r.id === "t3" ? { ...r, label: "billing" } : r));
    expect(await failing(p, { results: tampered })).toEqual(["results match the output hash", "results match each chunk's signed hash"]);
  });

  it("detects a chunk marked verified without a passing canary", async () => {
    const p = await makePassport();
    const body = { ...p, work: p.work.map((w) => ({ ...w, check: "verified" as const })), coverage: { verified: 2, formatOnly: 0, share: 1 } };
    const resigned = { ...body, attestations: { buyer: await signPassport(buyer, body) } };
    expect(await failing(resigned)).toEqual(expect.arrayContaining(["each verified chunk has a passing canary"]));
  });

  it("detects a canary reveal that doesn't match the commitment", async () => {
    const p = await makePassport();
    expect(await failing({ ...p, canaries: { ...p.canaries, revealed: [1] } })).toEqual(expect.arrayContaining(["canary reveal matches the commitment"]));
  });

  it("detects a verified chunk whose check scored below the agreed pass mark", async () => {
    const p = await makePassport();
    const body = { ...p, canaries: { ...p.canaries, checked: p.canaries.checked.map((c) => ({ ...c, agreement: 0.85 })) } };
    const resigned = { ...body, attestations: { buyer: await signPassport(buyer, body) } };
    expect(await failing(resigned)).toEqual(expect.arrayContaining(["verified chunks meet the agreed pass mark"]));
  });

  it("detects an outcome that claims more than the work shows", async () => {
    const p = await makePassport();
    const body = { ...p, work: p.work.slice(0, 1), completed: 1, coverage: { verified: 1, formatOnly: 0, share: 0.5 } };
    const resigned = { ...body, attestations: { buyer: await signPassport(buyer, body) } };
    expect(await failing(resigned, { results: results.slice(0, 2) })).toEqual(expect.arrayContaining(["outcome matches the work"]));
  });
});

describe("job agreement", () => {
  const policy = { canaryRate: 0.25, minAgreement: 0.8 };
  const budget = { asset: "0.0.0", maxSpend: "1000", maxPricePerChunk: "10" };
  const gold = [
    { id: "g1", text: "refund please", label: "billing" },
    { id: "g2", text: "app crashes", label: "bug" },
  ];

  it("never goes below the protocol's own rules", () => {
    const a = makeAgreement({ task, policy, budget, input: { canaryRate: 0.1, minAgreement: 0.5 } });
    expect(a.canaryRate).toBe(0.25);
    expect(a.minAgreement).toBe(0.8);
    expect(a.admission).toEqual({ source: "verifier", size: 0, minAccuracy: 0.8 });
  });

  it("commits to the buyer's examples by hash, not by content", () => {
    const a = makeAgreement({ task, policy, budget, input: { goldSet: gold, minAccuracy: 0.9, deadlineSeconds: 60 }, now: 0 });
    expect(a.admission).toEqual({ source: "buyer", size: 2, hash: goldHash(gold), minAccuracy: 0.9 });
    expect(a.deadline).toBe("1970-01-01T00:01:00.000Z");
    expect(JSON.stringify(a)).not.toContain("refund please");
    expect(agreementProblems(a, task, policy, gold)).toEqual([]);
  });

  it("is rejected when it doesn't match what the verifier receives", () => {
    const a = makeAgreement({ task, policy, budget, input: { goldSet: gold } });
    expect(agreementProblems(a, task, policy, [gold[0]])).toEqual(["admission examples don't match the agreement"]);
    expect(agreementProblems({ ...a, canaryRate: 0.1 }, task, policy, gold)).toEqual(["check rate must be between 0.25 and 1"]);
    expect(agreementProblems(a, { ...task, instructions: "something else" }, policy, gold)).toEqual(["agreement is for a different task"]);
    expect(agreementProblems(a, task, policy, [{ ...gold[0], label: "shipping" }, gold[1]])).toEqual(["admission examples need text and one of the task's labels"]);
  });
});

describe("Compute Passport v2: authenticity kept apart from correctness", () => {
  const resign = async (p: Passport) => {
    const { attestations: _, ...body } = p;
    return { ...body, attestations: { buyer: await signPassport(buyer, body), verifier: await signPassport(verifier, body) } } as Passport;
  };

  it("matches the published schema and derives every claim from the evidence", async () => {
    const p = await makePassport();
    expect(p.kind).toBe("kinetic.passport.v2");
    const checks = await verifyPassport(p, { results });
    for (const name of ["matches the Compute Passport v2 schema", "authenticity claims follow from the execution records", "correctness levels follow from the checks", "summary matches the evidence"]) {
      expect(checks.find((c) => c.name === name)?.ok).toBe(true);
    }
    expect(p.work.map((w) => w.correctness?.level)).toEqual(["model-agreement", "format-only"]);
    expect(p.work.every((w) => w.authenticity?.attestation === "none" && w.authenticity.model.hash === null)).toBe(true);
    expect(p.summary).toMatchObject({ verification: "partial", correctness: { groundTruth: 0, modelAgreement: 1, formatOnly: 1 }, payments: "settled" });
  });

  it("records TeeML and TeeTLS separately: a relayed model is never called TeeML", async () => {
    const { authenticityOf, guaranteeOf } = await import("../src/agent/assurance.js");
    expect(guaranteeOf("TeeML", "decentralized")).toBe("TeeML");
    expect(guaranteeOf("TeeML", "centralized")).toBe("TeeTLS");
    expect(guaranteeOf("SPML", "decentralized")).toBe("SPML");
    expect(guaranteeOf("", "decentralized")).toBe("none");
    const execution = { zgProvider: "0xabc", endpoint: "", model: "m", chatId: "c", verifiability: "TeeML", providerType: "centralized" as const, providerIdentity: "openai", responseHash: "ab".repeat(32), attestation: "verified" as const, latencyMs: 1, at: 1 };
    const a = authenticityOf({ check: "format", execution, attestation: "verified" }, "0g-compute:m");
    expect(a).toMatchObject({ method: "0g-direct", guarantee: "TeeTLS", attestation: "verified", node: "0xabc", model: { served: "m", hash: null } });
  });

  it("catches a passport that claims more than its evidence, even re-signed", async () => {
    const p = await makePassport();
    const overclaimed = await resign({ ...p, work: p.work.map((w, i) => (i === 1 ? { ...w, correctness: { methods: ["signature", "format", "known-answers"], level: "ground-truth" } } : w)) } as Passport);
    expect(await failing(overclaimed)).toContain("correctness levels follow from the checks");
    const fakeTee = await resign({ ...p, work: p.work.map((w) => ({ ...w, authenticity: { ...w.authenticity!, guarantee: "TeeML", attestation: "verified" } })) } as Passport);
    expect(await failing(fakeTee)).toContain("authenticity claims follow from the execution records");
    const rosy = await resign({ ...p, summary: { ...p.summary!, verification: "passed" } });
    expect(await failing(rosy)).toContain("summary matches the evidence");
    const broken = await resign({ ...p, summary: undefined } as unknown as Passport);
    expect(await failing(broken)).toContain("matches the Compute Passport v2 schema");
  });
});
