import { randomBytes } from "node:crypto";
import { agentProfile, uaidFor } from "../integrations/identity.js";
import { existsSync, readdirSync } from "node:fs";
import type { Server } from "node:http";
import type { Services } from "../integrations/index.js";
import { createApp, listen, route } from "../util/http.js";
import { logger } from "../util/log.js";
import { BuyerAgent, type BuyerPolicy, type JobReport } from "./buyer.js";
import { STRATEGIES, type Strategy } from "./ranking.js";
import type { AgreementInput } from "../core/agreement.js";
import { TIERS } from "../core/tiers.js";
import { loadJob, writeReport } from "./report.js";
import { HBAR, type Item, type PaymentAsset } from "../types.js";
import { findModels, resolveModel } from "../models/registry.js";
import { modelKey } from "../models/card.js";
import { publishModel, type CardDraft } from "../models/publish.js";
import { goldFor, loadGoldSets } from "../verifier/known.js";
import type { TaskSpec } from "../types.js";

// Local control API for the buyer agent, used by the dashboard's "Run a job" screen.
// It only starts and stops jobs; everything the dashboard shows about a job is still read
// from Arkiv, the Hedera mirror node and the verifier.

export interface Run {
  runId: string;
  jobId?: string;
  preset: string;
  /** The listed model the job runs, when one was chosen. */
  model?: { key: string; id: string; version: string };
  items: number;
  chunkSize: number;
  maxSpendTinybar: string;
  status: "starting" | "running" | "complete" | "incomplete" | "failed" | "halted";
  startedAt: number;
  finishedAt?: number;
  error?: string;
  report?: JobReport;
}

export interface AgentServiceOptions {
  port: number;
  verifierUrl: string;
  defaults: BuyerPolicy;
  itemsPath?: string;
  /** Upper bound on items per job, so a stray click can't spend a whole testnet balance. */
  maxItems?: number;
  /**
   * A creator account the dashboard may publish models with (POST /publish). Testnet demo only:
   * it signs cards and pays listing fees with this role's own key.
   */
  publisher?: Services;
}

/** Same task: kind plus label or field names. */
const sameTask = (a: TaskSpec, b: TaskSpec) =>
  a.kind === b.kind && JSON.stringify((a.labels ?? a.fields ?? []).map((l) => l.name).sort()) === JSON.stringify((b.labels ?? b.fields ?? []).map((l) => l.name).sort());

/** A publish started from the dashboard, and what's happened so far. */
interface Publish {
  key: string;
  id: string;
  version: string;
  creator: string;
  status: "publishing" | "listed" | "refused" | "failed";
  startedAt: number;
  finishedAt?: number;
  events: { at: number; message: string }[];
  feeTx?: string;
  error?: string;
  result?: { passportRef: string; accuracy: number; signers: string[] };
}

/** Job presets: the ticket tasks in data/*.task.json (on data/tickets.jsonl) and every task folder in data/tasks/. */
export function presets(): { id: string; kind: string; path: string; items?: string }[] {
  const tickets = readdirSync("data")
    .filter((f) => f.endsWith(".task.json"))
    .map((f) => ({ id: f.replace(".task.json", ""), path: `data/${f}`, kind: loadJob(`data/${f}`, "data/tickets.jsonl").task.kind }));
  const folders = existsSync("data/tasks")
    ? readdirSync("data/tasks")
        .filter((d) => existsSync(`data/tasks/${d}/task.json`) && existsSync(`data/tasks/${d}/items.jsonl`))
        .map((d) => ({ id: d, path: `data/tasks/${d}`, items: `data/tasks/${d}/items.jsonl`, kind: loadJob(`data/tasks/${d}`).task.kind }))
    : [];
  return [...tickets, ...folders];
}

export async function startAgentService(svc: Services, opts: AgentServiceOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const log = logger("agent-api");
  const runs: Run[] = [];
  const agents = new Set<BuyerAgent>();
  let halted = false;
  const itemsPath = opts.itemsPath ?? "data/tickets.jsonl";
  const maxItems = opts.maxItems ?? 120;
  const app = createApp();
  const buyerUaid = uaidFor(agentProfile({ role: "buyer", name: "kinetic-buyer", network: svc.cfg.network, hederaAccountId: svc.identity.hederaAccountId, evmAddress: svc.address }), svc.address);
  // What x402 payments settle in; prices, budgets and spoken amounts use it.
  const asset: PaymentAsset = HBAR;

  app.get("/presets", async (_req, res) => {
    res.json({ presets: presets().map(({ id, kind }) => ({ id, kind })), maxItems, defaults: opts.defaults, network: svc.cfg.network, halted, asset, uaid: await buyerUaid, account: svc.identity.hederaAccountId });
  });

  app.get("/runs", (_req, res) => void res.json({ runs: [...runs].reverse(), halted }));

  // The model registry as the buyer sees it: listings written by the vault's verifiers.
  app.get(
    "/models",
    route(async (_req, res) => {
      res.json({ models: await findModels(svc.arkiv, (await svc.vault.info()).verifiers) });
    }),
  );

  /** Starts a job in the background, for the form (/runs). */
  function launch(body: {
    preset?: string;
    /** A listed model (its key): the model's card sets the task. */
    model?: string;
    /** The buyer's own records, one per line, instead of a preset's. */
    texts?: unknown;
    items?: unknown;
    chunkSize?: unknown;
    maxSpendTinybar?: string;
    maxPriceTinybar?: string;
    strategy?: string;
    maxProviders?: unknown;
    /** Agreed rules from the form: share of chunks checked, pass mark, admission accuracy, deadline in seconds. */
    agreement?: { canaryRate?: unknown; minAgreement?: unknown; minAccuracy?: unknown; deadlineSeconds?: unknown; tier?: unknown };
  }): Run | { error: string; code: number } {
    if (halted) return { error: "agent is halted; resume it first", code: 409 };
    const preset = presets().find((p) => p.id === body.preset);
    const texts = Array.isArray(body.texts) ? body.texts.map((t) => String(t).trim()).filter(Boolean).slice(0, maxItems) : [];
    if (!body.model && !preset) return { error: "unknown preset", code: 400 };
    if (body.model && !/^m[0-9a-f]{15}$/.test(body.model)) return { error: "model must be a listed model's key", code: 400 };
    if (body.strategy && !STRATEGIES.includes(body.strategy as Strategy)) return { error: `strategy must be one of ${STRATEGIES.join(", ")}`, code: 400 };
    const items = texts.length || Math.max(1, Math.min(maxItems, Number(body.items) || 24));
    const chunkSize = Math.max(1, Math.min(20, Number(body.chunkSize) || 3));
    const maxProviders = Number(body.maxProviders) || undefined;
    const policy: BuyerPolicy = {
      ...opts.defaults,
      maxJobSpend: body.maxSpendTinybar ? BigInt(body.maxSpendTinybar) : opts.defaults.maxJobSpend,
      maxPricePerChunk: body.maxPriceTinybar ? BigInt(body.maxPriceTinybar) : opts.defaults.maxPricePerChunk,
      ...(body.strategy ? { strategy: body.strategy as Strategy } : {}),
      ...(maxProviders ? { maxProviders: Math.max(1, Math.floor(maxProviders)) } : {}),
      // Signed in with 0G: the user's credits also pay for this job's 0G checks at the verifier.
      ...(zerogKeySource === "user" && svc.cfg.zerog.apiKey ? { zerogKey: svc.cfg.zerog.apiKey } : {}),
    };
    // Only positive numbers count; the verifier still refuses anything below its own rules.
    const positive = (v: unknown, max = Infinity) => (typeof v === "number" && v > 0 && v <= max ? v : undefined);
    const a = body.agreement ?? {};
    const agreement: AgreementInput = Object.fromEntries(
      Object.entries({ canaryRate: positive(a.canaryRate, 1), minAgreement: positive(a.minAgreement, 1), minAccuracy: positive(a.minAccuracy, 1), deadlineSeconds: positive(a.deadlineSeconds), tier: TIERS.find((t) => t === a.tier) }).filter(
        ([, v]) => v !== undefined,
      ),
    );
    const run: Run = { runId: randomBytes(4).toString("hex"), preset: preset?.id ?? "own items", items, chunkSize, maxSpendTinybar: policy.maxJobSpend.toString(), status: "starting", startedAt: Date.now() };
    runs.push(run);
    const agent = new BuyerAgent(svc, opts.verifierUrl, policy);
    agents.add(agent);
    const job = preset ? loadJob(preset.path, preset.items ?? itemsPath) : loadJob("data/classify-tickets.task.json", itemsPath);
    const records: Item[] = texts.length ? texts.map((text, i) => ({ id: String(i + 1), text })) : job.items.slice(0, items);
    // A model job runs the model's own task; it is resolved from the registry, not trusted from the request.
    const listing = body.model ? svc.vault.info().then((info) => resolveModel(svc.arkiv, info.verifiers, body.model!)) : Promise.resolve(undefined);
    listing
      .then((model) => {
        if (model) run.model = { key: model.key, id: model.id, version: model.version };
        return agent.run({ task: model ? model.card.task : job.task, items: records, chunkSize, agreement, ...(model ? { model } : {}) }, { onJob: (jobId) => ((run.jobId = jobId), (run.status = "running")) });
      })
      .then((report) => {
        run.report = report;
        run.status = halted ? "halted" : report.status;
        writeReport(report);
      })
      .catch((err: Error) => {
        run.status = "failed";
        run.error = err.message;
        log("job failed", { runId: run.runId, error: err.message });
      })
      .finally(() => {
        run.finishedAt = Date.now();
        agents.delete(agent);
      });
    return run;
  }

  app.post(
    "/runs",
    route(async (req, res) => {
      const run = launch(req.body);
      if ("code" in run) return void res.status(run.code).json({ error: run.error });
      res.status(202).json(run);
    }),
  );

  // Sample inputs for a model's task, for the "Try it" panel: the first items of the job preset
  // whose task matches the model's card.
  app.get(
    "/models/:key/samples",
    route(async (req, res) => {
      const listing = await resolveModel(svc.arkiv, (await svc.vault.info()).verifiers, String(req.params.key));
      const preset = presets().find((p) => sameTask(loadJob(p.path, p.items ?? itemsPath).task, listing.card.task));
      const texts = preset ? loadJob(preset.path, preset.items ?? itemsPath).items.slice(0, 6).map((i) => i.text) : [];
      res.json({ texts });
    }),
  );

  // Publishing from the dashboard (testnet demo): the tasks the verifiers hold labelled examples
  // for, so a new model can be benchmarked without the creator's own set.
  const gold = loadGoldSets();
  const templates = () =>
    presets()
      .map((p) => ({ id: p.id, task: loadJob(p.path, p.items ?? itemsPath).task }))
      .filter((t) => goldFor(gold, t.task))
      .filter((t, i, all) => all.findIndex((o) => sameTask(o.task, t.task)) === i);
  app.get("/publish/templates", (_req, res) => void res.json({ templates: opts.publisher ? templates() : [], creator: opts.publisher?.address, payTo: opts.publisher?.payTo }));

  const publishes = new Map<string, Publish>();
  app.post(
    "/publish",
    route(async (req, res) => {
      const pub = opts.publisher;
      if (!pub) return void res.status(503).json({ error: "no creator account on this node: publish with npm run kinetic -- models publish" });
      const b = req.body as { template?: string; id?: string; version?: string; name?: string; description?: string; license?: string; royaltyBps?: number };
      const template = templates().find((t) => t.id === b.template);
      if (!template) return void res.status(400).json({ error: "pick one of the task templates" });
      const id = String(b.id ?? "").trim().toLowerCase();
      const version = String(b.version ?? "").trim();
      const key = modelKey(id, version);
      if (publishes.get(key)?.status === "publishing") return void res.status(409).json({ error: `${id}@${version} is already being published` });
      const card: CardDraft = {
        id,
        version,
        name: String(b.name ?? "").trim(),
        description: String(b.description ?? "").trim(),
        license: String(b.license ?? "apache-2.0").trim(),
        task: template.task,
        runtime: { engine: "0g", model: svc.cfg.zerog.model },
        royaltyBps: Math.round(Number(b.royaltyBps ?? 0)),
      };
      const state: Publish = { key, id, version, creator: pub.address, status: "publishing", startedAt: Date.now(), events: [] };
      publishes.set(key, state);
      const note = (message: string) => {
        state.events.push({ at: Date.now(), message });
        const fee = /listing fee (\S+)/.exec(message)?.[1];
        if (fee) state.feeTx = fee;
      };
      note(`card signed by creator ${pub.address}`);
      publishModel(pub, opts.verifierUrl, { card, timeoutMs: 30 * 60_000 }, note).then(
        (r) => Object.assign(state, { status: "listed", finishedAt: Date.now(), result: { passportRef: r.passportRef, accuracy: r.accuracy, signers: r.signers } }),
        (err: Error) => Object.assign(state, { status: /refused/.test(err.message) ? "refused" : "failed", finishedAt: Date.now(), error: err.message }),
      );
      log(`publishing ${id}@${version} from the dashboard`, { key });
      res.status(202).json(state);
    }),
  );
  app.get(
    "/publish/:key",
    route(async (req, res) => {
      const state = publishes.get(String(req.params.key));
      if (!state) return void res.status(404).json({ error: "no publish with that key from this node" });
      const review = await fetch(`${opts.verifierUrl.replace(/\/$/, "")}/models/reviews/${state.key}`)
        .then((r) => (r.ok ? r.json() : undefined))
        .catch(() => undefined);
      res.json({ ...state, review });
    }),
  );

  // 0G account sign-in: the dashboard hands over an API key created on the signed-in user's
  // 0G account, and from then on that user's credits pay for this agent's 0G calls. The
  // verifier keeps its own key: it's a separate party with its own budget.
  const teamKey = svc.cfg.zerog.apiKey;
  let zerogKeySource: "team" | "user" = "team";
  app.get("/zerog-key", (_req, res) => void res.json({ source: zerogKeySource }));
  // The signed-in user's 0G balance. Their dashboard tab reads it from the 0G router with their own
  // session and posts the figures here (numbers only, never a key), so any view of this agent can
  // show it; failing that, it's read with the agent's key where the router allows.
  let pushedBalance: { at: number; balance: Record<string, unknown> } | undefined;
  app.post("/zerog-balance", (req, res) => {
    if (zerogKeySource !== "user") return void res.status(409).json({ error: "the agent isn't using a signed-in 0G account" });
    const b = req.body as Record<string, unknown>;
    const pick = (k: string) => (typeof b[k] === "string" || typeof b[k] === "number" ? b[k] : undefined);
    pushedBalance = { at: Date.now(), balance: Object.fromEntries(["address", "currency", "credit_balance", "deposit_balance", "total_balance"].map((k) => [k, pick(k)]).filter(([, v]) => v !== undefined)) };
    res.json({ ok: true });
  });
  app.get(
    "/zerog-balance",
    route(async (_req, res) => {
      if (zerogKeySource !== "user") return void res.status(404).json({ error: "no 0G account signed in" });
      if (pushedBalance && Date.now() - pushedBalance.at < 60_000) return void res.json({ ...pushedBalance.balance, at: pushedBalance.at });
      const r = await fetch(`${svc.cfg.zerog.baseUrl.replace(/\/$/, "")}/account/balance`, { headers: { authorization: `Bearer ${svc.cfg.zerog.apiKey}` }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return void res.status(502).json({ error: `0G router ${r.status}` });
      res.json(await r.json());
    }),
  );
  app.post(
    "/zerog-key",
    route(async (req, res) => {
      const key = String(req.body.key ?? "");
      if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(key)) return void res.status(400).json({ error: "expected a 0G API key (sk-…)" });
      svc.cfg.zerog.apiKey = key;
      zerogKeySource = "user";
      log("0G key switched to the signed-in user's account");
      res.json({ source: zerogKeySource });
    }),
  );
  app.delete("/zerog-key", (_req, res) => {
    svc.cfg.zerog.apiKey = teamKey;
    zerogKeySource = "team";
    pushedBalance = undefined;
    res.json({ source: zerogKeySource });
  });

  // Kill switch for every running job, and its undo for new jobs.
  app.post("/halt", (_req, res) => {
    halted = true;
    for (const a of agents) a.halt();
    res.json({ halted, stopped: agents.size });
  });
  app.post("/resume", (_req, res) => {
    halted = false;
    res.json({ halted });
  });

  const server: Server = await listen(app, opts.port);
  log(`listening on http://localhost:${opts.port}`);
  return { url: `http://localhost:${opts.port}`, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}
