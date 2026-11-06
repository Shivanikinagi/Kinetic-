import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import { sha256Hex } from "../util/crypto.js";

// Malware checks for model files. KINETIC accepts weights only as safetensors: an 8-byte header
// length, a JSON header naming each tensor's dtype, shape and byte range, then raw tensor bytes.
// Nothing in that format can run when it's loaded. Pickle-based formats (.bin, .pt, .pkl, …) can
// execute arbitrary code on load, and custom model code (`auto_map`, `trust_remote_code`) runs
// by design, so both are refused outright.
//
// The checks are strict about the layout too: tensors must exactly tile the data section, with
// no gaps, overlaps or trailing bytes, so nothing can hide in a file that passes.
//
// What this can't do: detect a backdoor trained into the weights themselves. That is a property
// of the numbers, not the file, and is what the benchmark and the per-job checks are for.

/** Tensor dtypes the safetensors format defines, with their size in bytes. */
const DTYPE_BYTES: Record<string, number> = {
  BOOL: 1,
  U8: 1,
  I8: 1,
  F8_E4M3: 1,
  F8_E5M2: 1,
  I16: 2,
  U16: 2,
  F16: 2,
  BF16: 2,
  I32: 4,
  U32: 4,
  F32: 4,
  I64: 8,
  U64: 8,
  F64: 8,
};

/** The safetensors spec caps the header at 100 MB. */
export const MAX_HEADER_BYTES = 100_000_000;

/** Weight formats that can execute code when loaded, and code or binaries of any kind. */
const BLOCKED = /\.(bin|pt|pth|pkl|pickle|ckpt|joblib|npy|npz|h5|hdf5|keras|pb|onnx|gguf|ggml|mar|py|pyc|ipynb|sh|bash|bat|cmd|ps1|exe|dll|so|dylib|js|mjs|wasm|jar)$/i;

/** Small files a model may carry next to its weights. Everything else is refused. */
const CONFIG_FILES = /^(config|generation_config|tokenizer|tokenizer_config|special_tokens_map|added_tokens|preprocessor_config|vocab)\.json$/i;
const TEXT_FILES = /^(vocab\.txt|merges\.txt|readme\.md|license(\.md|\.txt)?)$/i;

/** Config keys that make a loader fetch and run custom Python code. */
const CODE_KEYS = ["auto_map", "trust_remote_code", "custom_pipelines"];

export interface SafetensorsInfo {
  headerBytes: number;
  tensors: number;
  params: number;
  dtypes: string[];
  metadata: Record<string, string>;
}

/**
 * Parses and checks one safetensors file. `problems` is empty when it is well-formed. Only the
 * header is read, so `bytes` may be just the file's first 8 + header-length bytes when
 * `fileSize` gives the whole file's size (how multi-GB weights are checked from disk).
 */
export function inspectSafetensors(bytes: Uint8Array, fileSize = bytes.length): { info?: SafetensorsInfo; problems: string[] } {
  const problems: string[] = [];
  if (fileSize < 8 || bytes.length < 8) return { problems: ["shorter than a safetensors header"] };
  const n = Number(new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true));
  if (n > MAX_HEADER_BYTES) return { problems: [`header of ${n} bytes is over the ${MAX_HEADER_BYTES}-byte limit`] };
  if (8 + n > fileSize || 8 + n > bytes.length) return { problems: ["header runs past the end of the file"] };
  let header: Record<string, unknown>;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(8, 8 + n));
    if (!text.trimStart().startsWith("{")) return { problems: ["header is not a JSON object"] };
    header = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { problems: ["header is not valid UTF-8 JSON"] };
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) return { problems: ["header is not a JSON object"] };

  const metadata: Record<string, string> = {};
  const raw = header.__metadata__;
  if (raw !== undefined) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) problems.push("__metadata__ is not an object");
    else
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v !== "string") problems.push(`__metadata__.${k} is not a string`);
        else metadata[k] = v;
      }
  }

  const ranges: { name: string; start: number; end: number }[] = [];
  const dtypes = new Set<string>();
  let params = 0;
  for (const [name, spec] of Object.entries(header)) {
    if (name === "__metadata__") continue;
    const t = spec as { dtype?: unknown; shape?: unknown; data_offsets?: unknown };
    if (!t || typeof t !== "object") {
      problems.push(`tensor ${name} is not an object`);
      continue;
    }
    const size = typeof t.dtype === "string" ? DTYPE_BYTES[t.dtype] : undefined;
    if (!size) {
      problems.push(`tensor ${name} has unknown dtype ${String(t.dtype)}`);
      continue;
    }
    if (!Array.isArray(t.shape) || t.shape.some((d) => !Number.isSafeInteger(d) || d < 0)) {
      problems.push(`tensor ${name} has a bad shape`);
      continue;
    }
    const offsets = t.data_offsets;
    if (!Array.isArray(offsets) || offsets.length !== 2 || offsets.some((o) => !Number.isSafeInteger(o) || o < 0) || offsets[1] < offsets[0]) {
      problems.push(`tensor ${name} has bad data_offsets`);
      continue;
    }
    const count = (t.shape as number[]).reduce((a, b) => a * b, 1);
    if (offsets[1] - offsets[0] !== count * size) problems.push(`tensor ${name} is ${offsets[1] - offsets[0]} bytes; its shape and dtype need ${count * size}`);
    ranges.push({ name, start: offsets[0], end: offsets[1] });
    dtypes.add(t.dtype as string);
    params += count;
  }
  if (ranges.length === 0) problems.push("no tensors");

  // The tensors must tile the data section exactly: no gaps, no overlaps, nothing after the last.
  const data = fileSize - 8 - n;
  let at = 0;
  for (const r of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (r.start < at) problems.push(`tensor ${r.name} overlaps another`);
    else if (r.start > at) problems.push(`${r.start - at} unaccounted bytes before tensor ${r.name}`);
    at = Math.max(at, r.end);
  }
  if (at !== data) problems.push(at < data ? `${data - at} unaccounted bytes after the last tensor` : "tensors run past the end of the file");

  return { info: { headerBytes: n, tensors: ranges.length, params, dtypes: [...dtypes].sort(), metadata }, problems };
}

export interface ModelFile {
  name: string;
  bytes: Uint8Array;
}

/** A model file on disk: how large weights are checked, without reading them into memory. */
export interface DiskModelFile {
  name: string;
  path: string;
}

/** What the checks need from one file: its hash and size, plus its header or (small) contents. */
interface PreparedFile {
  name: string;
  sha256: string;
  size: number;
  /** For safetensors: the header inspection. */
  safetensors?: ReturnType<typeof inspectSafetensors>;
  /** For configs and tokenizer text: the contents. */
  text?: Uint8Array;
  /** A file that couldn't be read for its checks. */
  problem?: string;
}

/** The most a config or tokenizer file may be: they're read whole to look for custom code. */
const MAX_CONFIG_BYTES = 64 * 1024 * 1024;

const isSafetensors = (name: string) => /\.safetensors$/i.test(name);
const isSmallKnown = (name: string) => CONFIG_FILES.test(name) || TEXT_FILES.test(name);

function prepareInMemory(f: ModelFile): PreparedFile {
  return {
    name: f.name,
    sha256: sha256Hex(f.bytes),
    size: f.bytes.length,
    ...(isSafetensors(f.name) ? { safetensors: inspectSafetensors(f.bytes) } : {}),
    ...(isSmallKnown(f.name) ? { text: f.bytes } : {}),
  };
}

/** sha256 of a file, streamed. */
export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function prepareOnDisk(f: DiskModelFile): Promise<PreparedFile> {
  const size = (await stat(f.path)).size;
  const base: PreparedFile = { name: f.name, sha256: await sha256OfFile(f.path), size };
  if (isSafetensors(f.name)) {
    const fd = await open(f.path, "r");
    try {
      const len = Buffer.alloc(8);
      await fd.read(len, 0, 8, 0);
      const n = size >= 8 ? Number(len.readBigUInt64LE(0)) : 0;
      // Read the header only when it fits; inspectSafetensors reports the problem otherwise.
      const head = Buffer.alloc(size >= 8 && n <= MAX_HEADER_BYTES && 8 + n <= size ? 8 + n : Math.min(size, 8));
      await fd.read(head, 0, head.length, 0);
      return { ...base, safetensors: inspectSafetensors(new Uint8Array(head.buffer, head.byteOffset, head.length), size) };
    } finally {
      await fd.close();
    }
  }
  if (isSmallKnown(f.name)) {
    if (size > MAX_CONFIG_BYTES) return { ...base, problem: `${f.name}: over ${MAX_CONFIG_BYTES / 1024 / 1024} MB, too large for a config or tokenizer file` };
    const fd = await open(f.path, "r");
    try {
      const text = Buffer.alloc(size);
      await fd.read(text, 0, size, 0);
      return { ...base, text: new Uint8Array(text.buffer, text.byteOffset, text.length) };
    } finally {
      await fd.close();
    }
  }
  return base;
}

/** scanModelFiles for files on disk: hashes are streamed and only headers and small files are read. */
export async function scanModelFilesOnDisk(files: DiskModelFile[]): Promise<ScanReport> {
  const prepared: PreparedFile[] = [];
  for (const f of files) prepared.push(await prepareOnDisk({ name: f.name || basename(f.path), path: f.path }));
  return assess(prepared);
}

export interface ScanCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ScannedFile {
  name: string;
  sha256: string;
  bytes: number;
  kind: "weights" | "config" | "text";
  tensors?: number;
  params?: number;
}

export interface ScanReport {
  ok: boolean;
  files: ScannedFile[];
  /** Total parameters across every weights file, read from the headers. */
  params: number;
  dtypes: string[];
  checks: ScanCheck[];
  problems: string[];
}

/** Runs every malware check on a model's files. A model is accepted only when `ok`. */
export function scanModelFiles(files: ModelFile[]): ScanReport {
  return assess(files.map(prepareInMemory));
}

function assess(files: PreparedFile[]): ScanReport {
  const problems: string[] = [];
  const scanned: ScannedFile[] = [];
  const dtypes = new Set<string>();
  let params = 0;
  const blocked: string[] = [];
  const unknown: string[] = [];
  const codeKeys: string[] = [];
  const badHeaders: string[] = [];

  const names = new Set<string>();
  for (const f of files) {
    const base = f.name.split(/[\\/]/).pop() ?? f.name;
    if (base !== f.name || base.startsWith(".") || !base) {
      problems.push(`${f.name}: file names must be plain names, without folders`);
      continue;
    }
    if (names.has(base.toLowerCase())) {
      problems.push(`${f.name}: listed twice`);
      continue;
    }
    names.add(base.toLowerCase());
    const entry = { name: base, sha256: f.sha256, bytes: f.size };
    if (f.problem) {
      problems.push(f.problem);
      continue;
    }
    if (BLOCKED.test(base)) {
      blocked.push(base);
      continue;
    }
    if (isSafetensors(base)) {
      const { info, problems: p } = f.safetensors ?? { problems: ["not read"] };
      if (p.length > 0) badHeaders.push(`${base}: ${p.slice(0, 2).join("; ")}`);
      if (info) {
        params += info.params;
        info.dtypes.forEach((d) => dtypes.add(d));
      }
      scanned.push({ ...entry, kind: "weights", ...(info ? { tensors: info.tensors, params: info.params } : {}) });
    } else if (CONFIG_FILES.test(base)) {
      try {
        const json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(f.text)) as unknown;
        const found = findKeys(json, CODE_KEYS);
        if (found.length > 0) codeKeys.push(`${base}: ${found.join(", ")}`);
      } catch {
        problems.push(`${base}: not valid JSON`);
      }
      scanned.push({ ...entry, kind: "config" });
    } else if (TEXT_FILES.test(base)) {
      scanned.push({ ...entry, kind: "text" });
    } else unknown.push(base);
  }

  const weights = scanned.filter((s) => s.kind === "weights");
  const checks: ScanCheck[] = [
    { name: "weights are safetensors only (no pickle or other executable formats)", ok: blocked.length === 0, ...(blocked.length ? { detail: blocked.join(", ") } : {}) },
    { name: "no files outside the allowed set (safetensors, JSON configs, tokenizer text)", ok: unknown.length === 0, ...(unknown.length ? { detail: unknown.join(", ") } : {}) },
    { name: "no custom model code (auto_map, trust_remote_code)", ok: codeKeys.length === 0, ...(codeKeys.length ? { detail: codeKeys.join("; ") } : {}) },
    { name: "every safetensors header is well-formed and its tensors exactly fill the file", ok: badHeaders.length === 0, ...(badHeaders.length ? { detail: badHeaders.join(" | ") } : {}) },
    { name: "at least one weights file", ok: weights.length > 0 },
  ];
  for (const c of checks) if (!c.ok) problems.push(c.detail ? `${c.name}: ${c.detail}` : c.name);
  return { ok: problems.length === 0, files: scanned, params, dtypes: [...dtypes].sort(), checks, problems };
}

function findKeys(value: unknown, keys: string[], path = ""): string[] {
  if (!value || typeof value !== "object") return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    const here = path ? `${path}.${k}` : k;
    if (keys.includes(k) && v !== false && v !== null) out.push(here);
    out.push(...findKeys(v, keys, here));
  }
  return out;
}

/** Builds a valid safetensors file from named float32 tensors (tests and examples). */
export function buildSafetensors(tensors: Record<string, { shape: number[]; values: number[] }>, metadata?: Record<string, string>): Uint8Array {
  const header: Record<string, unknown> = metadata ? { __metadata__: metadata } : {};
  let offset = 0;
  const parts: Uint8Array[] = [];
  for (const [name, t] of Object.entries(tensors)) {
    const data = new Uint8Array(new Float32Array(t.values).buffer);
    header[name] = { dtype: "F32", shape: t.shape, data_offsets: [offset, offset + data.length] };
    offset += data.length;
    parts.push(data);
  }
  let json = JSON.stringify(header);
  // Pad the header to a multiple of 8 bytes with spaces, as writers usually do.
  while ((json.length + 8) % 8 !== 0) json += " ";
  const head = new TextEncoder().encode(json);
  const out = new Uint8Array(8 + head.length + offset);
  new DataView(out.buffer).setBigUint64(0, BigInt(head.length), true);
  out.set(head, 8);
  let at = 8 + head.length;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
