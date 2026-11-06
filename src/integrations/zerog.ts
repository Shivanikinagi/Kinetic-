import type { NetworkConfig } from "../config.js";
import { buildMessages, parseModelOutput } from "../tasks/prompt.js";
import type { ChunkResult, Item, TaskSpec } from "../types.js";
import { withRetry } from "../util/http.js";
import { zeroGDirectory, type ZeroGDirectory } from "./zerog-compute.js";
import { verifyRouterRun, type CanaryTee } from "./zerog-tee.js";

// 0G Private Computer: an OpenAI-compatible router. Canary reference runs ask for the `private`
// trust tier (TeeML only: the model runs in the provider's enclave), fall back to `verified`
// with a recorded note when no TeeML provider is free, and we check the provider's TEE signature
// ourselves (zerog-tee.ts) instead of taking the router's `tee_verified`. Calls are paid from
// the verifier agent's 0G credits.

/** One reference run; a hung connection is abandoned and retried after this. */
const RUN_TIMEOUT_MS = 120_000;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ReferenceRun {
  result: ChunkResult;
  requestId: string;
  /** Router's verdict on the provider's TEE signature; null when the route gives none. */
  teeVerified: boolean | null;
  model: string;
  /**
   * Serving provider address and identity, from x_0g_trace. A TeeML model is served by a 0G
   * Compute node (an address, no identity); a TeeTLS model by an outside cloud named here.
   */
  provider: string;
  providerIdentity: string;
  /** The router's X-0G-E2EE header: "sealed" when the request was end-to-end encrypted to the TEE. */
  e2ee?: string;
  costUsdMicro: number;
  /** The trust mode it was served under. */
  trustMode?: string;
  /** Our own check of the provider's TEE signature (canary runs). */
  tee?: CanaryTee;
}

export interface RunOptions {
  /** Trust mode header; default the configured ZEROG_TRUST_MODE. */
  trustMode?: string;
  /** Trust mode to retry with, and record, when the first has no provider (503 no_provider_for_trust_mode). */
  fallback?: string;
  /** Fetch and check the provider's TEE signature ourselves. */
  selfVerify?: boolean;
}

/** The router found no provider in the requested trust tier (it never downgrades by itself). */
export class NoProviderForTrustMode extends Error {
  constructor(
    readonly trustMode: string,
    detail: string,
  ) {
    super(`0G router has no provider for trust mode ${trustMode}: ${detail}`);
  }
}

export class ZeroGClient {
  private spent = 0;
  private runs = 0;

  private readonly directory: ZeroGDirectory;

  /** `directory`: where the router's providers' TEE signers are looked up (default: the 0G chain at cfg.teeRpcUrl). */
  constructor(
    private readonly cfg: NetworkConfig["zerog"],
    directory?: ZeroGDirectory,
  ) {
    this.directory = directory ?? zeroGDirectory({ network: "testnet", zgCompute: { rpcUrl: cfg.teeRpcUrl || "https://evmrpc.0g.ai" } });
  }

  private headers(trustMode = this.cfg.trustMode): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.cfg.apiKey}`,
      "x-0g-provider-trust-mode": trustMode,
    };
  }

  /**
   * A canary's reference run: TeeML only (ZEROG_CANARY_TRUST_MODE, default `private`), its TEE
   * signature checked by us. With no TeeML provider free it runs in ZEROG_CANARY_FALLBACK
   * (`verified`) and the run records that; with ZEROG_CANARY_FALLBACK=none it fails instead and
   * the canary goes unscored.
   */
  async reference(task: TaskSpec, items: Item[]): Promise<ReferenceRun> {
    const fallback = this.cfg.canaryFallback && this.cfg.canaryFallback !== "none" ? this.cfg.canaryFallback : undefined;
    return this.runModel(this.cfg.model, task, items, { trustMode: this.cfg.canaryTrustMode || this.cfg.trustMode, fallback, selfVerify: true });
  }

  /** The same verified run on any 0G model, e.g. one a Model Passport is benchmarked on. */
  async runModel(model: string, task: TaskSpec, items: Item[], opts: RunOptions = {}): Promise<ReferenceRun> {
    const trustMode = opts.trustMode ?? this.cfg.trustMode;
    try {
      return await this.runOnce(model, task, items, trustMode, opts.selfVerify);
    } catch (err) {
      if (!(err instanceof NoProviderForTrustMode) || !opts.fallback || opts.fallback === trustMode) throw err;
      const note = `no ${trustMode} provider was available for ${model}, so it ran in ${opts.fallback} mode, which also admits TeeTLS relays to outside clouds`;
      return this.runOnce(model, task, items, opts.fallback, opts.selfVerify, note);
    }
  }

  private async runOnce(model: string, task: TaskSpec, items: Item[], trustMode: string, selfVerify = false, fallback?: string): Promise<ReferenceRun> {
    // A dropped connection or a busy router is retried: a run that never answered was never judged.
    // No seed and thinking left on: glm-5.3's TeeML providers don't take `seed`, and one of them
    // writes its reasoning into the answer under enable_thinking=false (probed 2026-11-03).
    const res = await withRetry("0G reference run", () =>
      fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(trustMode),
        body: JSON.stringify({
          model,
          messages: buildMessages(task, items),
          temperature: 0,
          // A router extension (stripped before the provider): the router checks the signature too.
          verify_tee: true,
        }),
        signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
      }),
    );
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 503 && text.includes("no_provider_for_trust_mode")) throw new NoProviderForTrustMode(trustMode, text.slice(0, 200));
      throw new Error(`0G reference run failed (${res.status}): ${text}`);
    }
    const body = (await res.json()) as {
      id?: string;
      choices: { message: { content: string } }[];
      model?: string;
      x_0g_trace?: {
        request_id?: string;
        tee_verified?: boolean;
        provider?: string;
        provider_identity?: string;
        billing?: { total_cost_usd_micro?: string | number };
      };
    };
    const trace = body.x_0g_trace ?? {};
    if (trace.tee_verified === false) throw new Error("0G router rejected the provider's TEE attestation");
    const costUsdMicro = Number(trace.billing?.total_cost_usd_micro ?? 0);
    this.runs += 1;
    this.spent += costUsdMicro;
    const provider = trace.provider ?? res.headers.get("x-provider") ?? "";
    let tee: CanaryTee | undefined;
    if (selfVerify) {
      const chatId = res.headers.get("zg-res-key") || body.id || "";
      tee = await verifyRouterRun(this.directory, { provider, chatId, trustMode, routerTeeVerified: trace.tee_verified ?? null, costUsdMicro, fallback });
      // A signature that contradicts the run means the reference can't be trusted: no canary is scored on it.
      if (tee.verification === "invalid") throw new Error(`0G reference run's TEE signature is invalid: ${tee.reason}`);
    }
    return {
      result: parseModelOutput(task, items, body.choices[0]?.message?.content ?? ""),
      requestId: trace.request_id ?? res.headers.get("x-request-id")?.split(",").pop()?.trim() ?? "",
      teeVerified: trace.tee_verified ?? null,
      model: body.model ?? model,
      provider,
      providerIdentity: trace.provider_identity ?? "",
      e2ee: res.headers.get("x-0g-e2ee") ?? undefined,
      costUsdMicro,
      trustMode,
      ...(tee ? { tee } : {}),
    };
  }

  /** Plain chat completion. Returns the text and the model that served it. */
  /** `truncated` is true when the reply hit the token limit and stops mid-thought. */
  async complete(messages: { role: "system" | "user" | "assistant"; content: string }[], opts: { maxTokens?: number; timeoutMs?: number } = {}): Promise<{ text: string; model: string; truncated: boolean }> {
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model: this.cfg.model, messages, temperature: 0, max_tokens: opts.maxTokens ?? 200 }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    if (!res.ok) throw new Error(`0G completion failed (${res.status}): ${await res.text()}`);
    const body = (await res.json()) as { choices: { message: { content: string }; finish_reason?: string }[]; model?: string };
    return { text: body.choices[0]?.message?.content ?? "", model: body.model ?? this.cfg.model, truncated: body.choices[0]?.finish_reason === "length" };
  }

  /** One chat turn with OpenAI-style tools: returns the assistant message (text or tool calls). */
  async chatWithTools(messages: ChatMessage[], tools: ToolSpec[], opts: { maxTokens?: number; timeoutMs?: number } = {}): Promise<{ message: ChatMessage; model: string }> {
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model: this.cfg.model, messages, tools, temperature: 0, max_tokens: opts.maxTokens ?? 800 }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new Error(`0G chat failed (${res.status}): ${await res.text()}`);
    const body = (await res.json()) as { choices: { message: ChatMessage }[]; model?: string };
    return { message: body.choices[0]?.message ?? { role: "assistant", content: "" }, model: body.model ?? this.cfg.model };
  }

  /** Remaining 0G credits on the verifier's account, or null if the router does not report it. */
  async balance(): Promise<number | null> {
    try {
      const res = await fetch(`${this.cfg.baseUrl}/account/balance`, { headers: this.headers() });
      if (!res.ok) return null;
      const body = (await res.json()) as Record<string, unknown>;
      const value = body.credits ?? body.balance ?? (body.data as Record<string, unknown> | undefined)?.balance;
      return value === undefined ? null : Number(value);
    } catch {
      return null;
    }
  }

  stats() {
    return { referenceRuns: this.runs, spentUsdMicro: this.spent, model: this.cfg.model, trustMode: this.cfg.trustMode, canaryTrustMode: this.cfg.canaryTrustMode || this.cfg.trustMode };
  }
}
