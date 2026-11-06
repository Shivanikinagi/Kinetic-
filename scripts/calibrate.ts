import "../src/env.js";
import { parseArgs } from "node:util";
import { loadJob } from "../src/agent/report.js";
import { loadNetworkConfig } from "../src/config.js";
import { ZeroGClient } from "../src/integrations/zerog.js";
import { lazyRun, OpenAICompatibleBackend } from "../src/provider/backend.js";
import { agreement } from "../src/tasks/compare.js";
import { loadRoleEnv } from "../src/testnet/roles.js";
import type { ChunkResult, Item } from "../src/types.js";

// Calibrates the canary threshold for a provider's model before a live run. A different
// model agrees with the 0G reference less often than 0G agrees with itself, and a threshold
// above an honest provider's agreement would slash it. This measures, on the same chunks:
//   - how often the local model agrees with the 0G reference (the canary check),
//   - its accuracy on the labelled gold tickets (the admission check),
//   - how a lazy provider scores against 0G (what the threshold must stay above),
//   - seconds per chunk (the buyer's and verifier's request timeouts are 180 s).
//
//   npm run calibrate -- [--url http://localhost:11434/v1] [--model qwen2.5:3b-instruct] [--chunks 6]

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    model: { type: "string" },
    chunks: { type: "string", default: "6" },
    size: { type: "string", default: "3" },
    task: { type: "string", default: "data/classify-tickets.task.json" },
  },
});

let env: Record<string, string | undefined>;
try {
  env = loadRoleEnv("verifier");
} catch {
  env = process.env;
}
const url = values.url ?? env.PROVIDER_MODEL_URL ?? "http://localhost:11434/v1";
const model = values.model ?? env.PROVIDER_MODEL ?? "qwen2.5:3b-instruct";
const size = Number(values.size);
const cfg = loadNetworkConfig(env);
const local = new OpenAICompatibleBackend(url, model);
const zerog = new ZeroGClient(cfg.zerog);

const chunksOf = (items: Item[], n: number) => Array.from({ length: Math.ceil(items.length / n) }, (_, i) => items.slice(i * n, i * n + n));
const pct = (x: number) => `${Math.round(x * 100)}%`;
const timed = async <T>(fn: () => Promise<T>) => {
  const t = Date.now();
  const value = await fn();
  return { value, seconds: (Date.now() - t) / 1000 };
};

const job = loadJob(values.task!, "data/tickets.jsonl");
const gold = loadJob(values.task!, "data/gold-tickets.jsonl");
console.log(`model ${model} at ${url}, ${values.chunks} chunks of ${size} vs 0G ${cfg.zerog.model}\n`);

// 1. Admission: accuracy on known answers.
const goldChunks = chunksOf(gold.items.slice(0, 2 * size), size);
const goldScores: number[] = [];
for (const items of goldChunks) {
  const truth: ChunkResult = { items: items.map((i) => ({ id: i.id, label: String((i as Item & { label?: string }).label) })) };
  const { value } = await timed(() => local.run(gold.task, items));
  goldScores.push(agreement(gold.task, truth, value));
}
const goldAcc = goldScores.reduce((a, b) => a + b, 0) / goldScores.length;
console.log(`known answers (admission): ${pct(goldAcc)}`);

// 2. Canaries: agreement with 0G, and how a lazy provider does.
const rows: { honest: number; lazy: number; seconds: number }[] = [];
for (const items of chunksOf(job.items, size).slice(0, Number(values.chunks))) {
  const [ref, mine] = await Promise.all([zerog.reference(job.task, items), timed(() => local.run(job.task, items))]);
  const row = { honest: agreement(job.task, ref.result, mine.value), lazy: agreement(job.task, ref.result, lazyRun(job.task, items)), seconds: mine.seconds };
  rows.push(row);
  console.log(`  chunk ${String(rows.length).padStart(2)}  agreement ${pct(row.honest).padStart(4)}  lazy ${pct(row.lazy).padStart(4)}  ${row.seconds.toFixed(1)} s`);
}

const honest = rows.map((r) => r.honest).sort((a, b) => a - b);
const lazyMax = Math.max(...rows.map((r) => r.lazy));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const slowest = Math.max(...rows.map((r) => r.seconds));
console.log(`\nagreement with 0G: mean ${pct(mean(honest))}, lowest ${pct(honest[0])}; lazy provider at most ${pct(lazyMax)}`);
console.log(`seconds per chunk: mean ${mean(rows.map((r) => r.seconds)).toFixed(1)}, slowest ${slowest.toFixed(1)}`);

// Pass threshold: below the honest model's lowest chunk, above the lazy provider's best.
const suggested = Math.floor(Math.max(lazyMax + 0.1, Math.min(honest[0] - 0.1, cfg.policy.minAgreement)) * 10) / 10;
console.log(`\ncurrent CANARY_MIN_AGREEMENT ${cfg.policy.minAgreement}; suggested ${suggested}`);
if (honest[0] < cfg.policy.minAgreement) console.log(`! an honest chunk scored ${pct(honest[0])}, below the current threshold: set CANARY_MIN_AGREEMENT=${suggested}`);
if (suggested <= lazyMax) console.log("! this model can't be told apart from a lazy provider on these chunks; use a larger model");
if (goldAcc < cfg.policy.minAgreement) console.log(`! known-answer accuracy ${pct(goldAcc)} is below the admission bar; this model would be rejected`);
if (slowest > 150) console.log("! chunks take close to the 180 s request timeout; use smaller chunks or a smaller model");
