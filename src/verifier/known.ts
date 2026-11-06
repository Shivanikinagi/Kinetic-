import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomInt } from "node:crypto";
import { itemCorrect } from "../tasks/compare.js";
import type { Item, ItemOutput, TaskSpec } from "../types.js";
import { canonicalJson, sha256Hex } from "../util/crypto.js";

// Ground-truth canaries. The verifier holds labelled examples nobody else sees. When a job
// registers, it plants one of them in every chunk, at a random position and under an id that
// looks like the buyer's own, then re-encrypts the chunk. A provider can't tell planted items
// from real ones, and every chunk is checked against a true answer, not against another
// model's opinion. Only these misses (with malformed output and invalid 0G records) count
// toward slashing; disagreeing with the 0G reference model fails the chunk but never slashes.
//
// The labelled set is split in two: admission probes are whole chunks of known answers, so a
// provider that logged them could spot planted items. Probes use one half, planting the other.

/** A labelled example: the true label (classify), tags (tag) or fields (extract). */
export type GoldItem = Item & { label?: string; tags?: string[]; fields?: Record<string, string | null> };

export interface GoldSet {
  task: TaskSpec;
  items: GoldItem[];
}

const readJsonl = <T>(path: string): T[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);

export function loadGold(paths = { task: process.env.GOLD_TASK || "data/classify-tickets.task.json", items: process.env.GOLD_SET || "data/gold-tickets.jsonl" }): GoldSet | null {
  try {
    return { task: JSON.parse(readFileSync(paths.task, "utf8")), items: readJsonl<GoldItem>(paths.items) };
  } catch {
    return null;
  }
}

/**
 * Every labelled set the verifier holds: the ticket set (GOLD_TASK, GOLD_SET) and one per task
 * in GOLD_DIR (default data/tasks/<task>/{task.json, gold.jsonl}). A job is checked against the
 * set whose task it is.
 */
export function loadGoldSets(dir = process.env.GOLD_DIR || "data/tasks"): GoldSet[] {
  const sets: GoldSet[] = [];
  const tickets = loadGold();
  if (tickets) sets.push(tickets);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      const task = join(dir, name, "task.json");
      const items = join(dir, name, "gold.jsonl");
      if (!existsSync(task) || !existsSync(items)) continue;
      const set = loadGold({ task, items });
      if (set && set.items.length > 0) sets.push(set);
    }
  }
  return sets;
}

/** The set whose task a job is, if the verifier has one. */
export function goldFor(sets: (GoldSet | null)[], task: TaskSpec): GoldSet | undefined {
  return sets.find((s): s is GoldSet => goldFits(s, task));
}

/** Which half of the labelled set an item belongs to: admission probes or planted canaries. Stable per text. */
const half = (text: string) => (parseInt(sha256Hex(text).slice(0, 2), 16) % 2 === 0 ? "admission" : "planted");

export function admissionPool(gold: GoldSet): GoldSet {
  return { task: gold.task, items: gold.items.filter((g) => half(g.text) === "admission") };
}

export function plantingPool(gold: GoldSet): GoldSet {
  return { task: gold.task, items: gold.items.filter((g) => half(g.text) === "planted") };
}

const labelNames = (t: TaskSpec) => JSON.stringify((t.labels ?? []).map((l) => l.name).sort());
const fieldNames = (t: TaskSpec) => JSON.stringify((t.fields ?? []).map((f) => f.name).sort());

/** Whether this labelled set can check a job's task: same kind, the same labels and the same fields. */
export function goldFits(gold: GoldSet | null | undefined, task: TaskSpec): gold is GoldSet {
  return !!gold && gold.items.length > 0 && task.kind === gold.task.kind && labelNames(task) === labelNames(gold.task) && fieldNames(task) === fieldNames(gold.task);
}

/** What a labelled item's correct output is. */
export function truthOf(task: TaskSpec, item: GoldItem, id: string): ItemOutput {
  switch (task.kind) {
    case "classify":
      return { id, label: item.label };
    case "tag":
      return { id, tags: item.tags ?? (item.label ? [item.label] : []) };
    case "extract":
      return { id, fields: Object.fromEntries((task.fields ?? []).map((f) => [f.name, item.fields?.[f.name] ?? null])) };
  }
}

/** Where known answers went in a job: which ids in which chunks. Committed on HCS, revealed at the end. */
export interface KnownPlan {
  placements: { idx: number; ids: string[] }[];
  salt: string;
  commitment: string;
}

export function commitKnown(jobId: string, placements: KnownPlan["placements"], salt: string): string {
  return sha256Hex(`${jobId}|${canonicalJson([...placements].sort((a, b) => a.idx - b.idx))}|${salt}`);
}

export function verifyKnownReveal(jobId: string, placements: KnownPlan["placements"], salt: string, commitment: string): boolean {
  return commitKnown(jobId, placements, salt) === commitment;
}

/**
 * An id that looks like the buyer's: same prefix and digit width when its ids end in digits,
 * otherwise random hex of the same length. Never one already used in the job.
 */
export function lookalikeId(sample: string[], taken: Set<string>): string {
  const pattern = sample.map((id) => /^(.*?)(\d+)$/.exec(id)).find(Boolean);
  for (let i = 0; i < 10_000; i++) {
    const id = pattern
      ? `${pattern[1]}${String(randomInt(0, 10 ** Math.min(pattern[2].length + (i > 5000 ? 1 : 0), 9))).padStart(pattern[2].length, "0")}`
      : randomBytes(Math.max(2, Math.ceil((sample[0]?.length ?? 8) / 2))).toString("hex").slice(0, Math.max(4, sample[0]?.length ?? 8));
    if (!taken.has(id)) return id;
  }
  throw new Error("could not find a free item id");
}

/** One planted item per chunk: the new chunk contents, and what each planted id should be answered. */
export function plant(
  jobId: string,
  task: TaskSpec,
  pool: GoldSet,
  chunks: { idx: number; items: Item[] }[],
): { chunks: { idx: number; items: Item[] }[]; truth: Map<string, ItemOutput>; plan: KnownPlan } {
  const taken = new Set(chunks.flatMap((c) => c.items.map((i) => i.id)));
  const sample = [...taken].slice(0, 20);
  const truth = new Map<string, ItemOutput>();
  const placements: KnownPlan["placements"] = [];
  const shuffled = [...pool.items].sort(() => Math.random() - 0.5);
  const out = chunks.map((c, n) => {
    const gold = shuffled[n % shuffled.length];
    const id = lookalikeId(sample, taken);
    taken.add(id);
    truth.set(id, truthOf(task, gold, id));
    placements.push({ idx: c.idx, ids: [id] });
    const items = [...c.items];
    items.splice(randomInt(0, items.length + 1), 0, { id, text: gold.text });
    return { idx: c.idx, items };
  });
  const salt = randomBytes(16).toString("hex");
  return { chunks: out, truth, plan: { placements, salt, commitment: commitKnown(jobId, placements, salt) } };
}

/** How a provider did on the known answers planted in one chunk. */
export function scoreKnown(task: TaskSpec, expected: ItemOutput[], output: ItemOutput[]): { items: number; correct: number; pass: boolean } {
  const byId = new Map(output.map((o) => [o.id, o]));
  const correct = expected.filter((e) => itemCorrect(task, e, byId.get(e.id))).length;
  return { items: expected.length, correct, pass: correct === expected.length };
}
