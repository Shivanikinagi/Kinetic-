import type { ChunkResult, ItemOutput, TaskSpec } from "../types.js";

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

function itemScore(task: TaskSpec, ref: ItemOutput, out: ItemOutput | undefined): number {
  if (!out) return 0;
  switch (task.kind) {
    case "classify":
      return ref.label !== undefined && norm(ref.label) === norm(out.label) ? 1 : 0;
    case "tag": {
      const a = new Set((ref.tags ?? []).map(norm));
      const b = new Set((out.tags ?? []).map(norm));
      if (a.size === 0 && b.size === 0) return 1;
      const inter = [...a].filter((t) => b.has(t)).length;
      return inter / new Set([...a, ...b]).size >= 0.5 ? 1 : 0;
    }
    case "extract": {
      const names = (task.fields ?? []).map((f) => f.name);
      if (names.length === 0) return 1;
      const hits = names.filter((n) => norm(ref.fields?.[n]) === norm(out.fields?.[n])).length;
      return hits / names.length;
    }
  }
}

/**
 * Exact correctness against a true answer: the same label, the same set of tags, or every
 * field equal (after trimming and lower-casing). Used for ground truth, where partial credit
 * would hide a wrong answer.
 */
export function itemCorrect(task: TaskSpec, truth: ItemOutput, out: ItemOutput | undefined): boolean {
  if (!out) return false;
  switch (task.kind) {
    case "classify":
      return truth.label !== undefined && norm(truth.label) === norm(out.label);
    case "tag": {
      const a = new Set((truth.tags ?? []).map(norm));
      const b = new Set((out.tags ?? []).map(norm));
      return a.size === b.size && [...a].every((t) => b.has(t));
    }
    case "extract":
      return (task.fields ?? []).every((f) => norm(truth.fields?.[f.name]) === norm(out.fields?.[f.name]));
  }
}

/** Mean per-item agreement between a provider's result and the 0G reference, in [0, 1]. */
export function agreement(task: TaskSpec, reference: ChunkResult, output: ChunkResult): number {
  if (reference.items.length === 0) return 1;
  const byId = new Map(output.items.map((i) => [i.id, i]));
  const total = reference.items.reduce((sum, ref) => sum + itemScore(task, ref, byId.get(ref.id)), 0);
  return total / reference.items.length;
}
