import type { ChunkResult, Item, ItemOutput, TaskSpec } from "../types.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// The same prompt goes to community GPUs and to 0G reference runs, so a disagreement
// reflects the provider, not a difference in instructions. The <task> and <items> blocks
// are machine-readable on purpose: the devnet 0G emulator parses them.

export function buildMessages(task: TaskSpec, items: Item[]): ChatMessage[] {
  const shape =
    task.kind === "classify"
      ? `{"id": string, "label": one of ${JSON.stringify((task.labels ?? []).map((l) => l.name))}}`
      : task.kind === "tag"
        ? `{"id": string, "tags": subset of ${JSON.stringify((task.labels ?? []).map((l) => l.name))}}`
        : `{"id": string, "fields": {${(task.fields ?? []).map((f) => `"${f.name}": string|null`).join(", ")}}}`;

  return [
    {
      role: "system",
      content:
        "You are a batch data-labelling worker. Answer every item. " +
        `Reply with JSON only, no prose: {"results": [${shape}, ...]}.`,
    },
    {
      role: "user",
      content: [
        task.instructions,
        `<task>${JSON.stringify(task)}</task>`,
        `<items>${JSON.stringify(items)}</items>`,
      ].join("\n\n"),
    },
  ];
}

export function parseTaskBlock(content: string): { task: TaskSpec; items: Item[] } | null {
  const task = content.match(/<task>([\s\S]*?)<\/task>/);
  const items = content.match(/<items>([\s\S]*?)<\/items>/);
  if (!task || !items) return null;
  return { task: JSON.parse(task[1]), items: JSON.parse(items[1]) };
}

/** Parses a model reply into a result with exactly one output per input item. */
export function parseModelOutput(task: TaskSpec, items: Item[], content: string): ChunkResult {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  let rows: ItemOutput[] = [];
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(content.slice(start, end + 1));
      rows = Array.isArray(parsed) ? parsed : (parsed.results ?? []);
    } catch {
      rows = [];
    }
  }
  const byId = new Map(rows.filter((r) => r && typeof r.id === "string").map((r) => [r.id, r]));
  return {
    items: items.map((item) => {
      const row = byId.get(item.id);
      if (task.kind === "classify") return { id: item.id, label: typeof row?.label === "string" ? row.label : undefined };
      if (task.kind === "tag") return { id: item.id, tags: Array.isArray(row?.tags) ? row!.tags.map(String) : [] };
      return { id: item.id, fields: row?.fields && typeof row.fields === "object" ? row.fields : {} };
    }),
  };
}
