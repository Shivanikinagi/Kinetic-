import type { ZeroGClient } from "../integrations/zerog.js";
import { OpenAICompatibleBackend } from "../provider/backend.js";
import type { ChunkResult, Item, TaskSpec } from "../types.js";
import type { ModelRuntime } from "./card.js";

// How a verifier runs a listed model itself, to benchmark it and fingerprint it before it gets a
// Model Passport. A 0G model runs on 0G Private Computer with the verifier's own credits (verified
// trust mode, so the request id and serving node are kept). A self-hosted model runs on the
// verifier's own OpenAI-compatible server (VERIFIER_MODEL_URL), from the same weights the card
// lists. Every verifier in the quorum runs it on its own, so no single one is trusted.

export interface ModelRun {
  result: ChunkResult;
  /** Where it ran, e.g. "0g:glm-5.3 (request devnet-…)" or "self-hosted:qwen2.5:3b-instruct". */
  ranOn: string;
}

export interface ModelRunner {
  run(runtime: ModelRuntime, task: TaskSpec, items: Item[]): Promise<ModelRun>;
}

export function defaultModelRunner(zerog: ZeroGClient, env: Record<string, string | undefined> = process.env): ModelRunner {
  return {
    async run(runtime, task, items) {
      if (runtime.engine === "0g") {
        const r = await zerog.runModel(runtime.model, task, items);
        return { result: r.result, ranOn: `0g:${r.model}${r.requestId ? ` (request ${r.requestId})` : ""}` };
      }
      const url = env.VERIFIER_MODEL_URL || "http://localhost:11434/v1";
      const backend = new OpenAICompatibleBackend(url, runtime.model, env.VERIFIER_MODEL_API_KEY);
      return { result: await backend.run(task, items), ranOn: `self-hosted:${runtime.model}` };
    },
  };
}

/** Runs items through a model in chunks of `size`, the way providers see them. */
export async function runInChunks(runner: ModelRunner, runtime: ModelRuntime, task: TaskSpec, items: Item[], size = 6): Promise<{ answers: ChunkResult["items"]; ranOn: string[] }> {
  const answers: ChunkResult["items"] = [];
  const ranOn: string[] = [];
  for (let i = 0; i < items.length; i += size) {
    const r = await runner.run(runtime, task, items.slice(i, i + size));
    answers.push(...r.result.items);
    ranOn.push(r.ranOn);
  }
  return { answers, ranOn };
}
