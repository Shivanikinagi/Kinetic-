import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenAICompatibleBackend, tokenUsage, tokenUsageFromRaw } from "../src/provider/backend.js";
import type { TaskSpec } from "../src/types.js";

// The speed figure in the dashboard's chat: token counts from an OpenAI-style `usage` object,
// and the time of the model call. Reported by the provider, unsigned, never paid on.

describe("token usage", () => {
  it("reads prompt and completion tokens from an OpenAI usage object", () => {
    expect(tokenUsage({ usage: { prompt_tokens: 120, completion_tokens: 18, total_tokens: 138 } })).toEqual({ promptTokens: 120, completionTokens: 18 });
  });

  it("ignores missing, negative or non-numeric counts", () => {
    expect(tokenUsage({})).toEqual({});
    expect(tokenUsage(null)).toEqual({});
    expect(tokenUsage({ usage: { prompt_tokens: "12", completion_tokens: -1 } })).toEqual({});
  });

  it("reads usage from raw response bytes, and tolerates bytes that aren't JSON", () => {
    const raw = Buffer.from(JSON.stringify({ choices: [], usage: { completion_tokens: 7 } })).toString("base64");
    expect(tokenUsageFromRaw(raw)).toEqual({ completionTokens: 7 });
    expect(tokenUsageFromRaw(Buffer.from("not json").toString("base64"))).toEqual({});
    expect(tokenUsageFromRaw(undefined)).toEqual({});
  });
});

describe("OpenAI-compatible backend", () => {
  let server: Server;
  let url = "";
  const task: TaskSpec = { kind: "classify", instructions: "Label it.", labels: [{ name: "billing" }, { name: "bug" }] };

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: '{"results":[{"id":"1","label":"bug"}]}' } }], usage: { prompt_tokens: 40, completion_tokens: 12 } }));
    });
    await new Promise<void>((r) => server.listen(0, r));
    url = `http://localhost:${(server.address() as { port: number }).port}/v1`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("returns the result with the call's time and token counts", async () => {
    const backend = new OpenAICompatibleBackend(url, "test-model");
    const { result, usage } = await backend.runMeasured(task, [{ id: "1", text: "the app crashes" }]);
    expect(result.items).toEqual([{ id: "1", label: "bug" }]);
    expect(usage.promptTokens).toBe(40);
    expect(usage.completionTokens).toBe(12);
    expect(usage.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("run still returns only the result, so result hashes are unchanged", async () => {
    const backend = new OpenAICompatibleBackend(url, "test-model");
    expect(await backend.run(task, [{ id: "1", text: "the app crashes" }])).toEqual({ items: [{ id: "1", label: "bug" }] });
  });
});
