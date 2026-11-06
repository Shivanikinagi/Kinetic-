import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { makeQuote } from "../src/core/quote.js";
import { cardDigest, cardProblems, cardSigner, compareVersions, MODEL_CARD_KIND, modelKey, parseModelRef, signCard, type ModelCard } from "../src/models/card.js";
import { compareReviews, type Review } from "../src/models/review.js";
import { buildSafetensors, inspectSafetensors, scanModelFiles, scanModelFilesOnDisk } from "../src/models/safetensors.js";
import { royaltyOf } from "../src/verifier/verifier.js";

const tensors = { w: { shape: [2, 2], values: [1, 2, 3, 4] }, b: { shape: [2], values: [0, 1] } };
const enc = (s: string) => new TextEncoder().encode(s);

/** A safetensors file with its header replaced, keeping the tensor bytes. */
function withHeader(header: object, data: Uint8Array): Uint8Array {
  const head = enc(JSON.stringify(header));
  const out = new Uint8Array(8 + head.length + data.length);
  new DataView(out.buffer).setBigUint64(0, BigInt(head.length), true);
  out.set(head, 8);
  out.set(data, 8 + head.length);
  return out;
}

describe("safetensors malware checks", () => {
  it("accepts a well-formed file and reads its parameters", () => {
    const { info, problems } = inspectSafetensors(buildSafetensors(tensors, { format: "pt" }));
    expect(problems).toEqual([]);
    expect(info).toMatchObject({ tensors: 2, params: 6, dtypes: ["F32"], metadata: { format: "pt" } });
  });

  it("refuses hidden bytes after the last tensor", () => {
    const file = buildSafetensors(tensors);
    const padded = new Uint8Array(file.length + 16);
    padded.set(file);
    expect(inspectSafetensors(padded).problems.join(" ")).toMatch(/unaccounted bytes after the last tensor/);
  });

  it("refuses overlapping tensors, gaps, wrong sizes and unknown dtypes", () => {
    const data = new Uint8Array(24);
    expect(inspectSafetensors(withHeader({ a: { dtype: "F32", shape: [3], data_offsets: [0, 12] }, b: { dtype: "F32", shape: [3], data_offsets: [8, 20] } }, data)).problems.join(" ")).toMatch(/overlaps/);
    expect(inspectSafetensors(withHeader({ a: { dtype: "F32", shape: [2], data_offsets: [4, 12] } }, data)).problems.join(" ")).toMatch(/unaccounted bytes before/);
    expect(inspectSafetensors(withHeader({ a: { dtype: "F32", shape: [2], data_offsets: [0, 12] } }, data)).problems.join(" ")).toMatch(/need 8/);
    expect(inspectSafetensors(withHeader({ a: { dtype: "PICKLE", shape: [2], data_offsets: [0, 8] } }, data)).problems.join(" ")).toMatch(/unknown dtype/);
  });

  it("refuses a header that claims more bytes than the file has, or isn't JSON", () => {
    const bad = new Uint8Array(16);
    new DataView(bad.buffer).setBigUint64(0, 1_000n, true);
    expect(inspectSafetensors(bad).problems.join(" ")).toMatch(/past the end/);
    expect(inspectSafetensors(withHeader([1, 2] as unknown as object, new Uint8Array())).problems.join(" ")).toMatch(/not a JSON object/);
  });

  it("refuses pickle files, code, unknown files and custom model code in configs", () => {
    const ok = { name: "model.safetensors", bytes: buildSafetensors(tensors) };
    const report = scanModelFiles([
      ok,
      { name: "pytorch_model.bin", bytes: enc("pickle") },
      { name: "modeling_evil.py", bytes: enc("import os") },
      { name: "notes.xyz", bytes: enc("?") },
      { name: "config.json", bytes: enc(JSON.stringify({ auto_map: { AutoModel: "evil.Model" } })) },
    ]);
    expect(report.ok).toBe(false);
    const failed = report.checks.filter((c) => !c.ok).map((c) => c.detail).join(" | ");
    expect(failed).toMatch(/pytorch_model\.bin/);
    expect(failed).toMatch(/modeling_evil\.py/);
    expect(failed).toMatch(/notes\.xyz/);
    expect(failed).toMatch(/auto_map/);
  });

  it("passes safetensors with JSON configs and tokenizer files", () => {
    const report = scanModelFiles([
      { name: "model.safetensors", bytes: buildSafetensors(tensors) },
      { name: "config.json", bytes: enc(JSON.stringify({ trust_remote_code: false, hidden_size: 2 })) },
      { name: "merges.txt", bytes: enc("a b") },
    ]);
    expect(report.problems).toEqual([]);
    expect(report.params).toBe(6);
    expect(report.files.map((f) => f.kind)).toEqual(["weights", "config", "text"]);
  });

  it("refuses file names with folders, so nothing is written outside the cache", () => {
    expect(scanModelFiles([{ name: "../model.safetensors", bytes: buildSafetensors(tensors) }]).ok).toBe(false);
  });

  it("checks files on disk the same as in memory, reading only headers and small files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kinetic-scan-"));
    try {
      const good = buildSafetensors(tensors);
      const files = [
        { name: "model.safetensors", bytes: good },
        { name: "config.json", bytes: enc(JSON.stringify({ hidden_size: 2 })) },
        { name: "merges.txt", bytes: enc("a b") },
      ];
      for (const f of files) writeFileSync(join(dir, f.name), f.bytes);
      const onDisk = await scanModelFilesOnDisk(files.map((f) => ({ name: f.name, path: join(dir, f.name) })));
      expect(onDisk).toEqual(scanModelFiles(files));
      expect(onDisk.ok).toBe(true);

      // Hidden bytes after the last tensor, and custom code in a config, are caught from disk too.
      const tampered = new Uint8Array([...good, 1, 2, 3]);
      writeFileSync(join(dir, "model.safetensors"), tampered);
      writeFileSync(join(dir, "config.json"), JSON.stringify({ auto_map: { AutoModel: "x.Model" } }));
      const bad = await scanModelFilesOnDisk(files.map((f) => ({ name: f.name, path: join(dir, f.name) })));
      expect(bad.ok).toBe(false);
      expect(bad.problems.join(" ")).toMatch(/unaccounted bytes after the last tensor/);
      expect(bad.problems.join(" ")).toMatch(/custom model code/);
      expect(bad.files.find((f) => f.name === "model.safetensors")?.bytes).toBe(tampered.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inspects a header given only the header bytes and the file's size", () => {
    const file = buildSafetensors(tensors);
    const n = Number(new DataView(file.buffer).getBigUint64(0, true));
    expect(inspectSafetensors(file.subarray(0, 8 + n), file.length)).toEqual(inspectSafetensors(file));
    expect(inspectSafetensors(file.subarray(0, 8 + n), file.length + 1).problems).toEqual(["1 unaccounted bytes after the last tensor"]);
  });
});

describe("model cards", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const card: ModelCard = {
    kind: MODEL_CARD_KIND,
    id: "acme/ticket-router",
    version: "1.2.0",
    name: "Ticket router",
    description: "Routes tickets.",
    license: "apache-2.0",
    creator: { address: account.address.toLowerCase(), payTo: "0.0.1234" },
    task: { kind: "classify", instructions: "Pick one.", labels: [{ name: "billing" }, { name: "bug" }] },
    runtime: { engine: "0g", model: "0gm-1.0-35b-a3b" },
    royaltyBps: 500,
    createdAt: "2026-11-02T00:00:00.000Z",
  };

  it("is signed by its creator, and any change breaks the signature", async () => {
    const sig = await signCard(account, card);
    expect(await cardSigner(card, sig)).toBe(card.creator.address);
    expect(await cardSigner({ ...card, royaltyBps: 3000 }, sig)).not.toBe(card.creator.address);
    expect(cardDigest(card)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("checks every field, and caps the royalty", () => {
    expect(cardProblems(card)).toEqual([]);
    expect(cardProblems({ ...card, royaltyBps: 3001 }).join(" ")).toMatch(/royaltyBps/);
    expect(cardProblems({ ...card, id: "No Spaces" }).join(" ")).toMatch(/namespace\/name/);
    expect(cardProblems({ ...card, runtime: { engine: "openai", model: "qwen2.5:3b" } }).join(" ")).toMatch(/needs its weights/);
    expect(cardProblems({ ...card, weights: { format: "safetensors", files: [{ name: "m.safetensors", sha256: "x", bytes: 1 }] } }).join(" ")).toMatch(/sha256/);
  });

  it("keys each version, and resolves references and versions", () => {
    expect(modelKey(card.id, "1.2.0")).toMatch(/^m[0-9a-f]{15}$/);
    expect(modelKey(card.id, "1.2.0")).not.toBe(modelKey(card.id, "1.2.1"));
    expect(parseModelRef("acme/ticket-router@1.2.0")).toEqual({ id: "acme/ticket-router", version: "1.2.0" });
    expect(parseModelRef("acme/ticket-router")).toEqual({ id: "acme/ticket-router" });
    expect(["1.2.0", "1.10.0", "1.9.3"].sort(compareVersions)).toEqual(["1.2.0", "1.9.3", "1.10.0"]);
  });
});

describe("royalties", () => {
  it("is the creator's share, rounded down to the tinybar", () => {
    expect(royaltyOf(1_000_000n, 500)).toBe(50_000n);
    expect(royaltyOf(999n, 500)).toBe(49n);
    expect(royaltyOf(1_000_000n, 0)).toBe(0n);
  });

  it("puts the most the royalty can be in the firm quote", () => {
    const plain = makeQuote({ chunks: 10, prices: [100_000n], feePerChunk: 10_000n, canaryRate: 0.25, protocolRate: 0.25 });
    const model = makeQuote({ chunks: 10, prices: [100_000n], feePerChunk: 10_000n, canaryRate: 0.25, protocolRate: 0.25, royaltyBps: 500 });
    expect(plain.royalty).toBeUndefined();
    expect(BigInt(model.royalty!)).toBe((BigInt(model.work) * 500n) / 10_000n);
    expect(BigInt(model.total)).toBe(BigInt(plain.total) + BigInt(model.royalty!));
  });
});

describe("quorum review", () => {
  const lead: Review = {
    key: "m0123456789abcde",
    weights: { checked: false, reason: "Served by 0G." },
    benchmark: { task: "t", source: "verifier", items: 10, itemsHash: "h", correct: 9, accuracy: 0.9, minAccuracy: 0.7, ranOn: [] },
    fingerprint: { task: "t", answers: { a: "billing", b: "bug", c: "bug", d: "other" } },
  };

  it("signs only when its own run reaches the same answers", () => {
    expect(compareReviews(lead, { ...lead, benchmark: { ...lead.benchmark, accuracy: 0.85 } })).toEqual([]);
    expect(compareReviews(lead, { ...lead, benchmark: { ...lead.benchmark, accuracy: 0.6 } }).join(" ")).toMatch(/benchmark 60% here/);
    expect(compareReviews(lead, { ...lead, benchmark: { ...lead.benchmark, itemsHash: "other" } }).join(" ")).toMatch(/different items/);
    expect(compareReviews(lead, { ...lead, fingerprint: { task: "t", answers: { a: "bug", b: "billing", c: "bug", d: "other" } } }).join(" ")).toMatch(/fingerprint matched 2 of 4/);
  });
});
