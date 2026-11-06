import type { ModelBackend } from "../../src/provider/backend.js";
import type { ChunkResult, FieldSpec, Item, ItemOutput, LabelSpec, TaskSpec } from "../../src/types.js";

// Deterministic keyword model. It stands in for a GPU model and for 0G on devnet,
// so a full job can run offline with known-correct answers.

const BUILTIN_PATTERNS: Record<string, RegExp> = {
  email: /[\w.+-]+@[\w-]+\.[\w.-]+/,
  phone: /\+?\d[\d\s-]{7,}\d/,
  amount: /[$€£₹]\s?\d+(?:[.,]\d{1,2})?/,
  date: /\b\d{4}-\d{2}-\d{2}\b/,
  order_id: /\b[A-Z]{2,4}-\d{3,}\b/,
};

function keywords(hint?: string): string[] {
  return (hint ?? "")
    .toLowerCase()
    .split(/[,;]/)
    .map((k) => k.trim())
    .filter(Boolean);
}

function score(text: string, label: LabelSpec): number {
  const lower = text.toLowerCase();
  return keywords(label.hint).reduce((n, k) => (lower.includes(k) ? n + 1 : n), 0);
}

function classify(text: string, labels: LabelSpec[]): string {
  let best = labels.find((l) => l.name === "other") ?? labels[0];
  let bestScore = 0;
  for (const label of labels) {
    const s = score(text, label);
    if (s > bestScore) {
      best = label;
      bestScore = s;
    }
  }
  return best.name;
}

function extract(text: string, fields: FieldSpec[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const field of fields) {
    const re = field.pattern ? new RegExp(field.pattern) : BUILTIN_PATTERNS[field.name];
    const match = re ? text.match(re) : null;
    out[field.name] = match ? match[0].trim() : null;
  }
  return out;
}

export function heuristicItem(task: TaskSpec, item: Item): ItemOutput {
  switch (task.kind) {
    case "classify":
      return { id: item.id, label: classify(item.text, task.labels ?? []) };
    case "tag":
      return {
        id: item.id,
        tags: (task.labels ?? []).filter((l) => score(item.text, l) > 0).map((l) => l.name),
      };
    case "extract":
      return { id: item.id, fields: extract(item.text, task.fields ?? []) };
  }
}

export function heuristicRun(task: TaskSpec, items: Item[]): ChunkResult {
  return { items: items.map((item) => heuristicItem(task, item)) };
}

/** The keyword model as a provider backend, so test providers give checkable answers. */
export class HeuristicBackend implements ModelBackend {
  readonly name = "heuristic";
  async run(task: TaskSpec, items: Item[]) {
    return heuristicRun(task, items);
  }
}
