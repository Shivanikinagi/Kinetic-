import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { loadJob } from "../src/agent/report.js";
import { loadNetworkConfig } from "../src/config.js";
import { connect } from "../src/integrations/index.js";
import { parseBehavior } from "../src/provider/backend.js";
import { startProvider, type RunningProvider } from "../src/provider/node.js";
import { builtInTasks, Kinetic, toTinybar, type KineticEvent } from "../src/sdk/index.js";
import { startVerifier } from "../src/verifier/service.js";
import { startDevnet, type Devnet } from "./support/devnet.js";
import { HeuristicBackend, heuristicRun } from "./support/heuristic.js";

// The SDK runs a whole job on the devnet: the same buyer agent, driven from application code.

const PORT = 14000;
let devnet: Devnet;
let verifier: { url: string; close: () => Promise<void> };
const providers: RunningProvider[] = [];
let settings: Record<string, string>;

beforeAll(async () => {
  devnet = await startDevnet({ port: PORT, disputeWindowSeconds: 0 });
  settings = { KINETIC_NETWORK: "devnet", DEVNET_URL: devnet.url, CANARY_RATE: "0.5" };
  const cfg = loadNetworkConfig(settings);
  const verifierSvc = connect(cfg, { privateKey: generatePrivateKey() });
  devnet.setVerifiers([verifierSvc.address]);
  devnet.fund(verifierSvc.address, 100_000_000n);
  verifier = await startVerifier(verifierSvc, PORT + 100);
  for (const [i, name] of ["sdk-a", "sdk-b"].entries()) {
    const svc = connect(cfg, { privateKey: generatePrivateKey() });
    devnet.fund(svc.address, 2_000_000_000n);
    providers.push(
      await startProvider(
        { name, port: PORT + 201 + i, gpu: "RTX 4090", tasks: ["classify", "extract", "tag"], priceTinybar: 100_000n, bondTinybar: 100_000_000n, backend: new HeuristicBackend(), behavior: parseBehavior("honest") },
        svc,
      ),
    );
  }
}, 60_000);

afterAll(async () => {
  for (const p of providers) await p.close();
  await verifier?.close();
  await devnet?.close();
});

describe("SDK", () => {
  it("parses HBAR amounts", () => {
    expect(toTinybar("0.5")).toBe(50_000_000n);
    expect(toTinybar("1 HBAR")).toBe(100_000_000n);
    expect(toTinybar("0.001 ℏ")).toBe(100_000n);
    expect(toTinybar(42n)).toBe(42n);
    expect(() => toTinybar("half")).toThrow();
  });

  it("lists the built-in tasks and which have known answers", () => {
    const tasks = builtInTasks();
    expect(tasks.find((t) => t.name === "sentiment")).toMatchObject({ kind: "classify", knownAnswers: true });
    expect(tasks.filter((t) => t.knownAnswers).length).toBeGreaterThanOrEqual(10);
  });

  it("runs a verified job by task name and returns results, payments and a passport", async () => {
    const events: KineticEvent[] = [];
    const kinetic = new Kinetic({ privateKey: generatePrivateKey(), verifierUrl: verifier.url, budget: { maxJobSpend: "0.5" }, settings, onEvent: (e) => events.push(e) });
    devnet.fund(kinetic.address, 1_000_000_000n);

    const offers = await kinetic.providers("classify");
    expect(offers.map((o) => o.name).sort()).toEqual(["sdk-a", "sdk-b"]);

    const { task, items } = loadJob("data/tasks/sentiment");
    let jobId: string | undefined;
    const report = await kinetic.run({ task: "sentiment", items: items.slice(0, 8), chunkSize: 2, onJob: (id) => (jobId = id) });
    expect(report.status).toBe("complete");
    expect(report.jobId).toBe(jobId);
    expect(report.results).toEqual(heuristicRun(task, items.slice(0, 8)).items);
    expect(report.paidTinybar).toBeGreaterThan(0n);
    expect(report.passport.ref).toBeTruthy();
    expect(events.length).toBeGreaterThan(0);
  }, 60_000);

  it("gives plain strings ids, warns about custom tasks, and honours the kill switch", async () => {
    const events: KineticEvent[] = [];
    const kinetic = new Kinetic({ privateKey: generatePrivateKey(), verifierUrl: verifier.url, settings, onEvent: (e) => events.push(e) });
    devnet.fund(kinetic.address, 1_000_000_000n);
    const custom = { kind: "classify" as const, instructions: "Is it about fruit?", labels: [{ name: "fruit" }, { name: "other" }] };
    const report = await kinetic.run({ task: custom, items: ["an apple", "a car", "a pear"], chunkSize: 3 });
    expect(report.results.map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(events.some((e) => e.message.startsWith("custom task"))).toBe(true);

    kinetic.halt();
    await expect(kinetic.run({ task: "sentiment", items: ["fine"] })).rejects.toThrow(/halted/);
    kinetic.resume();
  }, 60_000);
});
