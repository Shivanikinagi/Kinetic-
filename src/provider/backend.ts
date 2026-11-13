import type { NetworkConfig } from "../config.js";
import { ZeroGComputeBackend, zeroGComputeClient, type DirectRun } from "../integrations/zerog-compute.js";
import { buildMessages, parseModelOutput } from "../tasks/prompt.js";
import type { ChunkResult, ChunkUsage, Item, TaskSpec } from "../types.js";

/** Token counts from an OpenAI-style `usage` object, when the model server sent one. */
export function tokenUsage(body: unknown): Omit<ChunkUsage, "latencyMs"> {
  const u = (body as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);
  const promptTokens = n(u?.prompt_tokens);
  const completionTokens = n(u?.completion_tokens);
  return { ...(promptTokens !== undefined ? { promptTokens } : {}), ...(completionTokens !== undefined ? { completionTokens } : {}) };
}

/** Token counts from the raw response bytes (base64), as returned by a direct 0G Compute run. */
export function tokenUsageFromRaw(rawBase64: string | undefined): Omit<ChunkUsage, "latencyMs"> {
  if (!rawBase64) return {};
  try {
    return tokenUsage(JSON.parse(Buffer.from(rawBase64, "base64").toString("utf8")));
  } catch {
    return {};
  }
}

/** Where a provider actually runs inference: 0G Compute, or its own OpenAI-compatible server. */
export interface ModelBackend {
  readonly name: string;
  run(task: TaskSpec, items: Item[]): Promise<ChunkResult>;
  /** Same as run, plus how long the model took and the token counts it reported. */
  runMeasured?(task: TaskSpec, items: Item[]): Promise<{ result: ChunkResult; usage: ChunkUsage }>;
  /** Backends that call one 0G Compute provider directly also return where the chunk ran. */
  runWithEvidence?(task: TaskSpec, items: Item[]): Promise<DirectRun>;
  /** The 0G Compute provider every chunk runs on, for direct backends. Lower-case. */
  readonly zgProvider?: string;
}

/**
 * Any OpenAI-compatible endpoint: 0G Compute, or a server on the provider's own GPU (Ollama,
 * vLLM, llama.cpp, LM Studio, …). `kind` says which in the name the offer declares.
 */
export class OpenAICompatibleBackend implements ModelBackend {
  constructor(
    private readonly url: string,
    private readonly model: string,
    private readonly apiKey = "",
    private readonly kind: "0g" | "openai" = "openai",
  ) {}

  get name() {
    return `${this.kind}:${this.model}`;
  }

  async run(task: TaskSpec, items: Item[]) {
    return (await this.runMeasured(task, items)).result;
  }

  async runMeasured(task: TaskSpec, items: Item[]) {
    const started = Date.now();
    const res = await fetch(`${this.url.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.model, messages: buildMessages(task, items), temperature: 0 }),
    });
    if (!res.ok) throw new Error(`model server returned ${res.status}`);
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    const latencyMs = Date.now() - started;
    return { result: parseModelOutput(task, items, body.choices[0]?.message?.content ?? ""), usage: { latencyMs, ...tokenUsage(body) } };
  }
}

/** 0G's own model, served from 0G Compute nodes in a TEE (TeeML). */
export const DEFAULT_0G_WORKER_MODEL = "0gm-1.0-35b-a3b";

/**
 * The backend a provider declares, from PROVIDER_BACKEND: `0g` (default) runs through the 0G
 * router with the provider's own 0G key; `openai` runs on the provider's own OpenAI-compatible
 * server. `0g-compute` (one chosen 0G Compute provider, called directly) needs the network
 * config, so it comes from backendForEnv. There is no fallback: a provider runs exactly what it declares.
 */
export function backendFromEnv(env: Record<string, string | undefined>, zerog: { baseUrl: string; apiKey: string }): OpenAICompatibleBackend {
  const kind = env.PROVIDER_BACKEND || "0g";
  if (kind === "0g") {
    if (!zerog.apiKey) throw new Error("PROVIDER_BACKEND=0g needs ZEROG_API_KEY");
    return new OpenAICompatibleBackend(zerog.baseUrl, env.PROVIDER_MODEL || DEFAULT_0G_WORKER_MODEL, zerog.apiKey, "0g");
  }
  if (kind === "openai") return new OpenAICompatibleBackend(env.PROVIDER_MODEL_URL || "http://localhost:11434/v1", env.PROVIDER_MODEL || "qwen2.5:3b-instruct", env.PROVIDER_MODEL_API_KEY);
  if (kind === "0g-compute") throw new Error("PROVIDER_BACKEND=0g-compute needs the network config: use backendForEnv");
  throw new Error(`PROVIDER_BACKEND must be 0g, 0g-compute or openai, got ${kind}`);
}

/**
 * Any declared backend, `0g-compute` included: that one is bound to the 0G Compute provider at
 * ZG_PROVIDER_ADDRESS and pays from ZG_PRIVATE_KEY's 0G compute ledger (the role's own key when unset).
 */
export async function backendForEnv(env: Record<string, string | undefined>, cfg: NetworkConfig): Promise<ModelBackend> {
  if (env.PROVIDER_BACKEND !== "0g-compute") return backendFromEnv(env, cfg.zerog);
  if (!env.ZG_PROVIDER_ADDRESS) throw new Error("PROVIDER_BACKEND=0g-compute needs ZG_PROVIDER_ADDRESS (npm run zerog -- providers lists them)");
  return new ZeroGComputeBackend(zeroGComputeClient(cfg, env.ZG_PRIVATE_KEY || env.KINETIC_PRIVATE_KEY), env.ZG_PROVIDER_ADDRESS).init();
}

/**
 * How a provider behaves. Real providers run `honest`. The others are adversarial test
 * providers that really cheat: `lazy` never calls the model, `flaky` fails 40% of chunks,
 * `offline-after:N` goes down while chunk N is being paid and keeps that payment, `degrade-after:N` is honest
 * for N chunks (so it passes admission) and then stops calling the model, `zg-down-after:N`
 * answers N chunks and then fails every chunk as if its 0G Compute provider stopped answering
 * (a 0G outage can't be caused on demand, so this one is simulated at the KINETIC node). Every
 * adversarial provider says so in its offer, so dashboards and passports show it; buyers don't route on it.
 */
export type Behavior =
  | { kind: "honest" }
  | { kind: "lazy" }
  | { kind: "flaky"; rate: number }
  | { kind: "offline-after"; n: number }
  /** Honest for its first n chunks (so it passes qualification), lazy afterwards. */
  | { kind: "degrade-after"; n: number }
  /** Answers its first n chunks, then fails each one as if its 0G Compute provider were down. */
  | { kind: "zg-down-after"; n: number };

export function parseBehavior(value = "honest"): Behavior {
  if (value === "honest" || value === "") return { kind: "honest" };
  if (value === "lazy") return { kind: "lazy" };
  if (value === "flaky") return { kind: "flaky", rate: 0.4 };
  const m = value.match(/^offline-after:(\d+)$/);
  if (m) return { kind: "offline-after", n: Number(m[1]) };
  const d = value.match(/^degrade-after:(\d+)$/);
  if (d) return { kind: "degrade-after", n: Number(d[1]) };
  const z = value.match(/^zg-down-after:(\d+)$/);
  if (z) return { kind: "zg-down-after", n: Number(z[1]) };
  throw new Error(`unknown PROVIDER_BEHAVIOR ${value}`);
}

/** The label an adversarial provider publishes; undefined for an honest one. */
export function adversarialLabel(b: Behavior): string | undefined {
  switch (b.kind) {
    case "honest":
      return undefined;
    case "lazy":
      return "never calls its model";
    case "flaky":
      return `fails ${Math.round(b.rate * 100)}% of chunks`;
    case "offline-after":
      return `goes down while chunk ${b.n} is paid, keeping that payment`;
    case "degrade-after":
      return `stops calling its model after ${b.n} chunk${b.n === 1 ? "" : "s"}`;
    case "zg-down-after":
      return `simulates its 0G Compute provider going down after ${b.n} chunk${b.n === 1 ? "" : "s"}`;
  }
}

export function lazyRun(task: TaskSpec, items: Item[]): ChunkResult {
  const first = task.labels?.[0]?.name;
  return {
    items: items.map((item) =>
      task.kind === "classify"
        ? { id: item.id, label: first }
        : task.kind === "tag"
          ? { id: item.id, tags: [] }
          : { id: item.id, fields: Object.fromEntries((task.fields ?? []).map((f) => [f.name, null])) },
    ),
  };
}
