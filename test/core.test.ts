import { describe, expect, it } from "vitest";
import { commitCanaries, planCanaries, selectCanaries, verifyReveal } from "../src/core/canary.js";
import { splitIntoChunks } from "../src/core/chunker.js";
import { CanaryWindow } from "../src/core/policy.js";
import { makeQuote, verifierFee } from "../src/core/quote.js";
import { adversarialLabel, backendFromEnv, parseBehavior } from "../src/provider/backend.js";
import { agreement } from "../src/tasks/compare.js";
import { heuristicRun } from "./support/heuristic.js";
import { buildMessages, parseModelOutput, parseTaskBlock } from "../src/tasks/prompt.js";
import type { TaskSpec } from "../src/types.js";
import { canonicalJson, decrypt, deriveKey, encrypt, openString, randomKey, sealString } from "../src/util/crypto.js";

const classify: TaskSpec = {
  kind: "classify",
  instructions: "classify",
  labels: [
    { name: "billing", hint: "refund, invoice" },
    { name: "bug", hint: "crash, error" },
    { name: "other" },
  ],
};
const items = [
  { id: "a", text: "Please refund my invoice" },
  { id: "b", text: "App crash on start" },
  { id: "c", text: "Hello there" },
];

describe("chunker", () => {
  it("splits into fixed-size chunks with a short tail", () => {
    const chunks = splitIntoChunks(items, 2);
    expect(chunks.map((c) => c.map((i) => i.id))).toEqual([["a", "b"], ["c"]]);
  });
  it("rejects a non-positive chunk size", () => {
    expect(() => splitIntoChunks(items, 0)).toThrow();
  });
});

describe("canaries", () => {
  it("selects a sorted, distinct set of the requested size", () => {
    const picked = selectCanaries(40, 0.25);
    expect(picked).toHaveLength(10);
    expect(new Set(picked).size).toBe(10);
    expect([...picked].sort((a, b) => a - b)).toEqual(picked);
    expect(picked.every((i) => i >= 0 && i < 40)).toBe(true);
  });
  it("always checks at least the minimum", () => {
    expect(selectCanaries(3, 0.01, 1)).toHaveLength(1);
    expect(selectCanaries(0, 0.5)).toEqual([]);
  });
  it("commits and reveals", () => {
    const plan = planCanaries("job-1", 20, 0.3);
    expect(verifyReveal("job-1", plan.indices, plan.salt, plan.commitment)).toBe(true);
    expect(verifyReveal("job-1", [...plan.indices, 99], plan.salt, plan.commitment)).toBe(false);
    expect(verifyReveal("job-2", plan.indices, plan.salt, plan.commitment)).toBe(false);
    expect(commitCanaries("j", [3, 1, 2], "s")).toBe(commitCanaries("j", [1, 2, 3], "s"));
  });
});

describe("canary window", () => {
  const policy = { window: 10, failLimit: 3, minAgreement: 0.8 };
  it("breaches at 3 failures within the last 10", () => {
    const w = new CanaryWindow(policy);
    w.record(false);
    w.record(true);
    w.record(false);
    expect(w.breached).toBe(false);
    w.record(false);
    expect(w.breached).toBe(true);
  });
  it("forgets failures that slide out of the window", () => {
    const w = new CanaryWindow(policy);
    w.record(false);
    w.record(false);
    for (let i = 0; i < 9; i++) w.record(true);
    expect(w.failures).toBe(1);
    w.record(true);
    expect(w.failures).toBe(0);
    w.record(false);
    expect(w.breached).toBe(false);
  });
  it("survives a round trip through its saved form", () => {
    const w = new CanaryWindow(policy);
    for (const pass of [true, false, true, false]) w.record(pass);
    expect(w.toString()).toBe("1010");
    const restored = CanaryWindow.restore(policy, w.toString());
    expect(restored.failures).toBe(2);
    restored.record(false);
    expect(restored.breached).toBe(true);
    expect(CanaryWindow.restore(policy, "").size).toBe(0);
  });
});

describe("tasks", () => {
  it("heuristic classifies by keywords and falls back to other", () => {
    expect(heuristicRun(classify, items).items.map((i) => i.label)).toEqual(["billing", "bug", "other"]);
  });
  it("agreement is the share of matching items", () => {
    const ref = heuristicRun(classify, items);
    expect(agreement(classify, ref, ref)).toBe(1);
    const wrong = { items: ref.items.map((i) => ({ ...i, label: "billing" })) };
    expect(agreement(classify, ref, wrong)).toBeCloseTo(1 / 3);
    expect(agreement(classify, ref, { items: [] })).toBe(0);
  });
  it("scores extraction per field", () => {
    const task: TaskSpec = { kind: "extract", instructions: "x", fields: [{ name: "email" }, { name: "order_id" }] };
    const ref = { items: [{ id: "a", fields: { email: "a@b.co", order_id: "ORD-1" } }] };
    const half = { items: [{ id: "a", fields: { email: "A@B.co", order_id: null } }] };
    expect(agreement(task, ref, half)).toBe(0.5);
  });
  it("round-trips a prompt through the machine-readable block and parses noisy model output", () => {
    const messages = buildMessages(classify, items);
    expect(parseTaskBlock(messages[1].content)).toEqual({ task: classify, items });
    const parsed = parseModelOutput(classify, items, 'Sure! ```json\n{"results":[{"id":"b","label":"bug"}]}\n```');
    expect(parsed.items).toEqual([{ id: "a", label: undefined }, { id: "b", label: "bug" }, { id: "c", label: undefined }]);
  });
});

describe("crypto", () => {
  it("encrypts and decrypts with derived keys", () => {
    const master = randomKey();
    const k1 = deriveKey(master, "chunk:1");
    const sealed = encrypt(k1, new TextEncoder().encode("hello"));
    expect(new TextDecoder().decode(decrypt(k1, sealed))).toBe("hello");
    expect(() => decrypt(deriveKey(master, "chunk:2"), sealed)).toThrow();
  });
  it("seals a string for a public record", () => {
    const key = randomKey();
    const ref = "ab".repeat(64);
    const sealed = sealString(key, ref);
    expect(sealed).not.toContain(ref);
    expect(openString(key, sealed)).toBe(ref);
  });
  it("canonical JSON is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: { d: 2n, c: [1] } })).toBe(canonicalJson({ a: { c: [1], d: 2n }, b: 1 }));
  });
});

describe("format validation", () => {
  it("accepts a well-formed result and names every problem in a malformed one", async () => {
    const { validateResult } = await import("../src/tasks/validate.js");
    expect(validateResult(classify, items, heuristicRun(classify, items))).toEqual([]);
    const bad = { items: [{ id: "a", label: "refunds" }, { id: "a", label: "bug" }, { id: "zz", label: "bug" }] };
    const problems = validateResult(classify, items, bad);
    expect(problems).toContain('item a: label "refunds" is not allowed');
    expect(problems).toContain("item a answered twice");
    expect(problems).toContain("unknown item id zz");
    expect(problems).toContain("item b not answered");
  });
});

describe("provider backends", () => {
  const zerog = { baseUrl: "https://router-api.0g.ai/v1", apiKey: "key" };
  it("runs exactly what it declares, on 0G Compute by default", () => {
    expect(backendFromEnv({}, zerog).name).toBe("0g:0gm-1.0-35b-a3b");
    expect(backendFromEnv({ PROVIDER_BACKEND: "0g", PROVIDER_MODEL: "glm-5.3" }, zerog).name).toBe("0g:glm-5.3");
    expect(backendFromEnv({ PROVIDER_BACKEND: "openai", PROVIDER_MODEL: "qwen2.5:3b-instruct" }, zerog).name).toBe("openai:qwen2.5:3b-instruct");
    expect(() => backendFromEnv({}, { ...zerog, apiKey: "" })).toThrow(/ZEROG_API_KEY/);
    expect(() => backendFromEnv({ PROVIDER_BACKEND: "heuristic" }, zerog)).toThrow(/0g, 0g-compute or openai/);
  });
  it("labels adversarial test providers, and only them", () => {
    expect(adversarialLabel(parseBehavior("honest"))).toBeUndefined();
    expect(adversarialLabel(parseBehavior("lazy"))).toBe("never calls its model");
    expect(adversarialLabel(parseBehavior("degrade-after:1"))).toBe("stops calling its model after 1 chunk");
    expect(adversarialLabel(parseBehavior("offline-after:3"))).toBe("goes down while chunk 3 is paid, keeping that payment");
  });
});

describe("firm quote", () => {
  it("covers every chunk plus a reroute allowance at the highest price, plus the verifier's fee", () => {
    const q = makeQuote({ chunks: 20, prices: [100_000n, 60_000n, 120_000n], feePerChunk: 10_000n, canaryRate: 0.25, protocolRate: 0.25 });
    expect(q).toEqual({ chunks: 20, allowance: 5, maxPricePerChunk: "120000", work: "3000000", fee: "200000", total: "3200000" });
  });
  it("charges more when the buyer asks for more checks, exactly as the verifier does", () => {
    expect(verifierFee(20, 10_000n, 0.5, 0.25)).toBe(400_000n);
    expect(makeQuote({ chunks: 1, prices: [100n], feePerChunk: 0n, canaryRate: 0.25, protocolRate: 0.25 }).allowance).toBe(1);
  });
});
