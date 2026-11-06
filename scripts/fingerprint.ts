import "../src/env.js";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadJob } from "../src/agent/report.js";
import { loadNetworkConfig } from "../src/config.js";
import { buildProbes, type FingerprintSet } from "../src/core/fingerprint.js";
import { OpenAICompatibleBackend } from "../src/provider/backend.js";
import { loadRoleEnv } from "../src/testnet/roles.js";
import type { Item } from "../src/types.js";

// Builds the model fingerprints the verifier checks providers against: runs real models on
// borderline tickets (data/fingerprint-candidates.jsonl) a few times each, keeps every model's
// stable answers, and picks the items that tell each model apart. Spends a little 0G credit.
//
//   npm run fingerprint -- [--models 0gm-1.0-35b-a3b,glm-5.3,...] [--runs 2] [--ollama qwen2.5:3b-instruct]

const DEFAULT_MODELS = ["0gm-1.0-35b-a3b", "glm-5.3", "qwen3.7-flash", "qwen3.5-flash", "qwen-flash", "qwen3.5-27b", "deepseek-v4-flash", "minimax-m3.1-flash", "mimo-v2.6-flash", "glm-5.3-flash"];

const { values } = parseArgs({
  options: {
    models: { type: "string" },
    runs: { type: "string", default: "2" },
    ollama: { type: "string" },
    "ollama-url": { type: "string", default: "http://localhost:11434/v1" },
    task: { type: "string", default: "data/classify-tickets.task.json" },
    candidates: { type: "string", default: "data/fingerprint-candidates.jsonl" },
    out: { type: "string", default: "data/fingerprints.json" },
  },
});

let env: Record<string, string | undefined>;
try {
  env = loadRoleEnv("verifier");
} catch {
  env = process.env;
}
const cfg = loadNetworkConfig(env);
if (!cfg.zerog.apiKey) throw new Error("needs ZEROG_API_KEY (the verifier's role env or .env)");

const { task, items } = loadJob(values.task!, values.candidates!);
const runs = Number(values.runs);
const chunks: Item[][] = [];
for (let i = 0; i < items.length; i += 4) chunks.push(items.slice(i, i + 4));
const backends: Record<string, OpenAICompatibleBackend> = Object.fromEntries(
  (values.models ? values.models.split(",").map((m) => m.trim()) : DEFAULT_MODELS).map((m) => [m, new OpenAICompatibleBackend(cfg.zerog.baseUrl, m, cfg.zerog.apiKey, "0g")]),
);
if (values.ollama) backends[values.ollama] = new OpenAICompatibleBackend(values["ollama-url"]!, values.ollama);

const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms))]);

const answers: Record<string, Record<string, string>[]> = {};
for (const [model, backend] of Object.entries(backends)) {
  answers[model] = [];
  let failed = 0;
  for (let r = 0; r < runs; r++) {
    const run: Record<string, string> = {};
    for (let i = 0; i < chunks.length; i += 4) {
      const out = await Promise.allSettled(chunks.slice(i, i + 4).map((c) => withTimeout(backend.run(task, c), 120_000)));
      for (const o of out) {
        if (o.status === "rejected") {
          failed++;
          continue;
        }
        for (const it of o.value.items) if (it.label) run[it.id] = it.label;
      }
    }
    answers[model].push(run);
  }
  console.log(`${model.padEnd(22)} answered ${Object.keys(answers[model][0] ?? {}).length}/${items.length}${failed ? `, ${failed} chunk calls failed` : ""}`);
}

const texts = Object.fromEntries(items.map((i) => [i.id, i.text]));
const { models, probes } = buildProbes(answers, texts);
const set: FingerprintSet = { task: values.task!, builtAt: new Date().toISOString(), models, probes };
writeFileSync(values.out!, JSON.stringify(set, null, 2) + "\n");

console.log(`\nstable answers and probe items per model (written to ${values.out}):`);
for (const m of Object.keys(models)) console.log(`  ${m.padEnd(22)} stable ${String(Object.keys(models[m]).length).padStart(2)}/${items.length}  probes ${probes[m].length}`);
