import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildProbes, judgeFingerprint, modelOf, type FingerprintSet } from "../src/core/fingerprint.js";

// Two models that label borderline tickets differently, one that wavers between runs.
const texts = { f1: "charged twice after a crash", f2: "can't log in to update my card", f3: "parcel damaged, want a refund", f4: "app is slow", f5: "thanks!" };
const runs = {
  big: [
    { f1: "billing", f2: "account", f3: "shipping", f4: "bug", f5: "other" },
    { f1: "billing", f2: "account", f3: "shipping", f4: "bug", f5: "other" },
  ],
  small: [
    { f1: "bug", f2: "billing", f3: "billing", f4: "bug", f5: "other" },
    { f1: "bug", f2: "billing", f3: "billing", f4: "bug", f5: "other" },
  ],
  wobbly: [
    { f1: "billing", f2: "account", f3: "billing", f4: "other", f5: "other" },
    { f1: "bug", f2: "account", f3: "shipping", f4: "bug", f5: "other" },
  ],
};

describe("model fingerprints", () => {
  it("reads the model out of a declared backend", () => {
    expect(modelOf("0g:0gm-1.0-35b-a3b")).toBe("0gm-1.0-35b-a3b");
    expect(modelOf("openai:qwen2.5:3b-instruct")).toBe("qwen2.5:3b-instruct");
    expect(modelOf(undefined)).toBeUndefined();
  });

  it("keeps only answers a model gives every time, and only items another model answers differently", () => {
    const { models, probes } = buildProbes(runs, texts);
    expect(models.wobbly).toEqual({ f2: "account", f5: "other" });
    // f4 and f5 get the same answer from both stable models, so they can't tell them apart.
    expect(probes.big.map((p) => p.id).sort()).toEqual(["f1", "f2", "f3"]);
    expect(probes.small.find((p) => p.id === "f1")).toEqual({ id: "f1", text: texts.f1, label: "bug" });
  });

  it("says consistent when a provider answers like its declared model", () => {
    const { models } = buildProbes(runs, texts);
    expect(judgeFingerprint({ f1: "billing", f2: "account", f3: "shipping" }, { models }, "big")).toEqual({ declared: "big", match: 1, verdict: "consistent", items: 3 });
  });

  it("says mismatch, and names the model it looks like, when it answers like another one", () => {
    const { models } = buildProbes(runs, texts);
    const r = judgeFingerprint({ f1: "bug", f2: "billing", f3: "billing" }, { models }, "big");
    expect(r.verdict).toBe("mismatch");
    expect(r.match).toBe(0);
    expect(r.closest).toBe("small");
    expect(r.closestMatch).toBe(1);
  });

  it("won't judge on too few answers", () => {
    const { models } = buildProbes(runs, texts);
    expect(judgeFingerprint({ f1: "billing", f2: "account" }, { models }, "big").verdict).toBe("inconclusive");
  });
});

describe("the measured fingerprints (data/fingerprints.json)", () => {
  const set = JSON.parse(readFileSync("data/fingerprints.json", "utf8")) as FingerprintSet;
  const declared = "0gm-1.0-35b-a3b";
  const answersOf = (model: string) => Object.fromEntries(set.probes[declared].filter((p) => set.models[model][p.id]).map((p) => [p.id, set.models[model][p.id]]));

  it("has probes for the providers' model", () => {
    expect(set.probes[declared].length).toBeGreaterThanOrEqual(12);
  });

  it("recognises the providers' model, and catches a provider that swaps in a small cheap one", () => {
    expect(judgeFingerprint(answersOf(declared), set, declared).verdict).toBe("consistent");
    const swapped = judgeFingerprint(answersOf("qwen2.5:3b-instruct"), set, declared);
    expect(swapped.verdict).toBe("mismatch");
    expect(swapped.match).toBeLessThan(0.5);
  });
});
