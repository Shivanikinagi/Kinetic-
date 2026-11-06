import "../src/env.js";
import { appendFileSync, existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadNetworkConfig } from "../src/config.js";
import { ZeroGClient } from "../src/integrations/zerog.js";
import { DEFAULT_0G_WORKER_MODEL } from "../src/provider/backend.js";
import { itemCorrect } from "../src/tasks/compare.js";
import { loadGold, truthOf } from "../src/verifier/known.js";

// Calibrates the labelled sets before they can slash anyone. Every labelled item is run through
// real 0G models (the providers' model and the verifier's reference model, by default) and kept
// only if every model answers it exactly as labelled. A planted known answer that a good model
// gets "wrong" would slash an honest provider, so an ambiguous item is worse than none.
//
//   npm run gold:check                      report, per task, which items a model disagrees with
//   npm run gold:check -- --write           also drop those items (appended to gold.rejected.jsonl)
//   --models a,b   models to check against · --task sentiment  only this task folder
//
// Spends 0G credits (ZEROG_API_KEY): about one call per model per six items.

const { values } = parseArgs({ options: { write: { type: "boolean", default: false }, models: { type: "string" }, task: { type: "string" } } });
const cfg = loadNetworkConfig();
const models = (values.models ?? `${process.env.PROVIDER_MODEL || DEFAULT_0G_WORKER_MODEL},${cfg.zerog.model}`).split(",").map((m) => m.trim());
const DIR = process.env.GOLD_DIR || "data/tasks";
const BATCH = 6;

const sources = [
  { name: "ticket-category", task: process.env.GOLD_TASK || "data/classify-tickets.task.json", gold: process.env.GOLD_SET || "data/gold-tickets.jsonl" },
  ...(existsSync(DIR) ? readdirSync(DIR).sort() : []).map((d) => ({ name: d, task: join(DIR, d, "task.json"), gold: join(DIR, d, "gold.jsonl") })),
].filter((s) => existsSync(s.task) && existsSync(s.gold) && (!values.task || s.name === values.task));

async function run(client: ZeroGClient, task: Parameters<ZeroGClient["reference"]>[0], items: { id: string; text: string }[]) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.reference(task, items);
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

let kept = 0;
let total = 0;
for (const src of sources) {
  const set = loadGold({ task: src.task, items: src.gold })!;
  const bad = new Map<string, string[]>();
  for (const model of models) {
    const client = new ZeroGClient({ ...cfg.zerog, model });
    for (let i = 0; i < set.items.length; i += BATCH) {
      const part = set.items.slice(i, i + BATCH);
      const ids = part.map((_, k) => `x${String(i + k).padStart(3, "0")}`);
      const out = await run(client, set.task, part.map((g, k) => ({ id: ids[k], text: g.text })));
      for (const [k, g] of part.entries()) {
        const got = out.result.items.find((o) => o.id === ids[k]);
        if (!itemCorrect(set.task, truthOf(set.task, g, ids[k]), got)) bad.set(g.text, [...(bad.get(g.text) ?? []), `${model}: ${JSON.stringify(got?.label ?? got?.tags ?? got?.fields ?? null)}`]);
      }
    }
  }
  total += set.items.length;
  kept += set.items.length - bad.size;
  console.log(`\n${src.name} (${set.task.kind}): ${set.items.length - bad.size}/${set.items.length} answered as labelled by ${models.join(" and ")}`);
  for (const [text, why] of bad) console.log(`  ✗ ${text.slice(0, 72)}  →  ${why.join("; ")}`);
  if (values.write && bad.size > 0) {
    const keep = set.items.filter((g) => !bad.has(g.text));
    writeFileSync(`${src.gold}.tmp`, keep.map((g) => JSON.stringify(g)).join("\n") + "\n");
    renameSync(`${src.gold}.tmp`, src.gold);
    appendFileSync(src.gold.replace(/\.jsonl$/, ".rejected.jsonl"), set.items.filter((g) => bad.has(g.text)).map((g) => JSON.stringify(g)).join("\n") + "\n");
    console.log(`  kept ${keep.length}; ${bad.size} moved to ${src.gold.replace(/\.jsonl$/, ".rejected.jsonl")}`);
  }
}
console.log(`\n${kept}/${total} labelled items answered as labelled by every model${values.write ? "" : " (add --write to drop the rest)"}`);
