import type { ChunkResult, Item, TaskSpec } from "../types.js";

// Format check applied to every chunk, not just canaries (in the spirit of Kimi Vendor
// Verifier's schema tests). A result must answer each input item exactly once, and only
// with values the task allows.

export function validateResult(task: TaskSpec, items: Item[], result: ChunkResult): string[] {
  const problems: string[] = [];
  const ids = new Set(items.map((i) => i.id));
  const seen = new Set<string>();
  const labels = new Set((task.labels ?? []).map((l) => l.name));
  const fields = new Set((task.fields ?? []).map((f) => f.name));

  if (!result || !Array.isArray(result.items)) return ["result has no items array"];
  for (const out of result.items) {
    if (!out || typeof out.id !== "string" || !ids.has(out.id)) {
      problems.push(`unknown item id ${String(out?.id)}`);
      continue;
    }
    if (seen.has(out.id)) problems.push(`item ${out.id} answered twice`);
    seen.add(out.id);
    if (task.kind === "classify" && (typeof out.label !== "string" || !labels.has(out.label))) problems.push(`item ${out.id}: label ${JSON.stringify(out.label)} is not allowed`);
    if (task.kind === "tag" && (!Array.isArray(out.tags) || out.tags.some((t) => !labels.has(t)))) problems.push(`item ${out.id}: tags must be a subset of the allowed labels`);
    if (task.kind === "extract" && (!out.fields || typeof out.fields !== "object" || Object.keys(out.fields).some((k) => !fields.has(k)))) problems.push(`item ${out.id}: fields must use the task's field names`);
  }
  for (const id of ids) if (!seen.has(id)) problems.push(`item ${id} not answered`);
  return problems;
}
