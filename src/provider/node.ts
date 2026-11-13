import type { Server } from "node:http";
import { ensureAgent, Erc8004, type Registration } from "../integrations/erc8004.js";
import { agentProfile, uaidFor, uaidKey } from "../integrations/identity.js";
import { z } from "zod";
import { TTL, type ArkivStore } from "../integrations/arkiv.js";
import type { Services } from "../integrations/index.js";
import { PaymentGate, ReplayGuard } from "../integrations/x402.js";
import type { ChunkRequest, ChunkResponse, ChunkResult, ChunkUsage, Item, TaskKind, ZeroGExecution } from "../types.js";
import { canonicalJson, decryptJson, fromBase64, sha256Hex } from "../util/crypto.js";
import { createApp, listen, route } from "../util/http.js";
import { logger } from "../util/log.js";
import { executionHash, signResult } from "../util/sign.js";
import { encryptionKeyOf, unwrapKey, wrapContext } from "../util/wrap.js";
import { stateFile } from "../util/state.js";
import { adversarialLabel, lazyRun, tokenUsageFromRaw, type Behavior, type ModelBackend } from "./backend.js";
import { UpstreamError } from "../integrations/zerog-compute.js";
import type { ServedModel } from "./models.js";

export interface ProviderOptions {
  name: string;
  port: number;
  publicUrl?: string;
  gpu: string;
  tasks: TaskKind[];
  priceTinybar: bigint;
  bondTinybar: bigint;
  backend: ModelBackend;
  behavior: Behavior;
  heartbeatMs?: number;
  /** HCS-10 inbound topic from the Hashgraph Online registry, published in the offer. */
  hcs10Inbound?: string;
  /** Listed models this provider serves, each checked against its Model Passport (prepareModels). */
  models?: ServedModel[];
  /**
   * Finds models listed since it started (given the keys it serves), checked like the rest; they're
   * added to the offer as they appear. Polled every `discoverMs` (default a minute).
   */
  discoverModels?: (known: Set<string>) => Promise<ServedModel[]>;
  discoverMs?: number;
  /** How it isolates the models it runs, as it declares it (PROVIDER_SANDBOX, e.g. "docker:no-network"). */
  sandbox?: string;
}

/** This provider's address was slashed: it can't bond again. Rotate to a new key to take part again. */
export class ProviderSlashedError extends Error {
  constructor(readonly address: string) {
    super(`${address} was slashed: the vault won't take a new bond (rotate to a new key: npm run setup:testnet -- --rotate <role>)`);
  }
}

export interface RunningProvider {
  name: string;
  address: string;
  url: string;
  offerKey: string;
  served: () => number;
  close: () => Promise<void>;
}

const chunkRequestSchema = z.object({
  jobId: z.string().min(1).max(64),
  idx: z.number().int().nonnegative(),
  task: z.object({ kind: z.enum(["classify", "extract", "tag"]), instructions: z.string() }).passthrough(),
  // The sealed chunk itself (base64). A chunk is at most 20 items, so 2 MB is far more than enough.
  data: z.string().min(16).max(2_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  wrappedKey: z.string().min(80).optional(),
  chunkKey: z.string().min(40).optional(),
  model: z.string().regex(/^m[0-9a-f]{15}$/).optional(),
});

export async function startProvider(opts: ProviderOptions, svc: Services): Promise<RunningProvider> {
  const log = logger(opts.name);
  const url = opts.publicUrl ?? `http://localhost:${opts.port}`;

  // 1. Bond. Buyers read bonds from the vault, not from the offer, so this is what counts.
  const bond = await svc.vault.bondOf(svc.address);
  // A slashed address can't bond again (the vault refuses) and no buyer would use it, so it
  // doesn't start: publishing and renewing an offer would only spend Arkiv gas for nothing.
  if (bond.slashed) throw new ProviderSlashedError(svc.address);
  if (bond.amountTinybar < opts.bondTinybar) {
    const tx = await svc.vault.postBond(opts.bondTinybar - bond.amountTinybar);
    log("bond posted", { amount: opts.bondTinybar - bond.amountTinybar, tx });
  }
  const bonded = (await svc.vault.bondOf(svc.address)).amountTinybar;

  // 2. x402 gate: one payment per chunk, paid to this provider's own account.
  const gate = new PaymentGate({
    network: svc.cfg.x402.network,
    facilitatorUrl: svc.cfg.x402.facilitatorUrl,
    facilitatorUrls: svc.cfg.x402.facilitatorUrls,
    asset: svc.cfg.x402.asset,
    payTo: svc.payTo,
    amount: opts.priceTinybar,
    description: `KINETIC chunk on ${opts.name} (${opts.gpu})`,
    replay: new ReplayGuard(stateFile(svc.cfg, `replay-${svc.address}.json`)),
  });
  await gate.getRequirements();

  let served = 0;
  let server: Server | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  const models = new Map((opts.models ?? []).map((m) => [m.key, m]));
  const runChunk = async (body: ChunkRequest): Promise<ChunkResponse> => {
    // A model job runs on that model's backend; anything else on the provider's own.
    const backend = body.model ? models.get(body.model)!.backend : opts.backend;
    if (opts.behavior.kind === "flaky" && Math.random() < opts.behavior.rate) throw new Error("GPU worker crashed");
    if (opts.behavior.kind === "zg-down-after" && served >= opts.behavior.n) throw new UpstreamError(zgProvider ?? "unknown", "answered 503 (simulated outage)");
    // The chunk key arrives wrapped to this provider's own key, bound to this job and chunk.
    const key = body.wrappedKey ? unwrapKey(svc.identity.privateKey, body.wrappedKey, wrapContext(body.jobId, body.idx, svc.address)) : body.chunkKey ? fromBase64(body.chunkKey) : undefined;
    if (!key) throw new Error("no chunk key in the request");
    const items = decryptJson<Item[]>(key, fromBase64(body.data));
    const lazyNow = opts.behavior.kind === "lazy" || (opts.behavior.kind === "degrade-after" && served >= opts.behavior.n);
    // A direct 0G Compute backend also says where the chunk ran; the signature covers that too.
    // The model call is timed for the speed figure (`usage`), which is reported but never signed.
    const started = Date.now();
    let run: { result: ChunkResult; execution?: ZeroGExecution; rawResponse?: string; usage?: ChunkUsage };
    if (lazyNow) run = { result: lazyRun(body.task, items) };
    else if (backend.runWithEvidence) {
      const r = await backend.runWithEvidence(body.task, items);
      run = { ...r, usage: { latencyMs: r.execution.latencyMs ?? Date.now() - started, ...tokenUsageFromRaw(r.rawResponse) } };
    } else if (backend.runMeasured) run = await backend.runMeasured(body.task, items);
    else run = { result: await backend.run(body.task, items) };
    const { result, execution, rawResponse } = run;
    // A lazy provider never called a model, so it has no speed to report.
    const usage: ChunkUsage | undefined = lazyNow ? undefined : (run.usage ?? { latencyMs: Date.now() - started });
    const resultHash = sha256Hex(canonicalJson(result));
    const signature = await signResult(svc.account, body.jobId, body.idx, resultHash, executionHash(execution), body.model);
    return {
      jobId: body.jobId,
      idx: body.idx,
      result,
      resultHash,
      provider: svc.address,
      signature,
      ...(execution ? { execution, rawResponse } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(usage ? { usage } : {}),
    };
  };

  const app = createApp();
  app.get("/health", (_req, res) => {
    res.json({ name: opts.name, provider: svc.address, payTo: svc.payTo, gpu: opts.gpu, backend: opts.backend.name, ...(zgProvider ? { zgProvider } : {}), served, ...(adversarial ? { adversarial } : {}), models: [...models.keys()], ...(opts.sandbox ? { sandbox: opts.sandbox } : {}) });
  });
  app.post(
    "/v1/chunks",
    route(async (req, res) => {
      const parsed = chunkRequestSchema.safeParse(req.body);
      if (!parsed.success) return void res.status(400).json({ error: "bad_request", issues: parsed.error.issues });
      const body = parsed.data as ChunkRequest;
      // Refused before any payment: the buyer is never charged for a model this node doesn't serve.
      if (body.model && !models.has(body.model)) return void res.status(400).json({ error: "model_not_served", model: body.model });
      await gate.handle(req, res, async () => {
        const out = await runChunk(body);
        served += 1;
        log(`chunk ${body.jobId}#${body.idx} done`, { served });
        if (opts.behavior.kind === "offline-after" && served >= opts.behavior.n) {
          // Adversarial outage: really stop serving and renewing, and leave the offer to expire on Arkiv.
          setTimeout(() => crash(), 50);
        }
        return out;
      });
    }),
  );

  server = await listen(app, opts.port);

  // 3. Offer on Arkiv. It expires unless the heartbeat keeps extending it, so a dead node drops out.
  // The offer carries the provider's HCS-14 UAID and the profile it was derived from.
  const profile = agentProfile({ role: "provider", name: opts.name, network: svc.cfg.network, hederaAccountId: svc.identity.hederaAccountId, evmAddress: svc.address });
  const uaid = await uaidFor(profile, svc.address);
  const adversarial = adversarialLabel(opts.behavior);
  if (adversarial) log(`adversarial test provider: ${adversarial}`);
  // The 0G Compute provider this node runs on, when it calls one directly. Buyers reroute on it.
  const zgProvider = opts.backend.zgProvider;
  // ERC-8004 on 0G Chain: this GPU registers itself as an agent (it owns the identity, so the
  // verifier's feedback on it counts). Never fatal: a node without 0G gas still serves.
  let erc8004: Registration | undefined;
  if (svc.cfg.erc8004.enabled) {
    try {
      erc8004 = await ensureAgent(
        new Erc8004(svc.cfg.erc8004, svc.account),
        svc.address,
        () => ({
          name: `${opts.name} (KINETIC GPU)`,
          description: `A KINETIC GPU provider (${opts.gpu}): ${bonded > 0n ? "bonded in HBAR on Hedera, " : ""}paid per chunk over x402, checked against hidden known answers and 0G TeeML canaries in every job.`,
          services: [{ name: "web", endpoint: url }, { name: "HCS-14", endpoint: uaid }],
          x402Support: true,
          active: true,
          supportedTrust: ["reputation", "crypto-economic"],
        }),
        svc.cfg.stateDir,
      );
      log("ERC-8004 agent on 0G", { agentId: erc8004.agentId, tx: erc8004.tx });
    } catch (err) {
      log("ERC-8004 registration failed", { error: (err as Error).message.slice(0, 160) });
    }
  }
  const offerAttrs = () => ({
        provider: svc.address,
        pay_to: svc.payTo,
        name: opts.name,
        endpoint: url,
        gpu: opts.gpu,
        price: opts.priceTinybar,
        bond: bonded,
        uaid: uaidKey(uaid),
        ...Object.fromEntries(opts.tasks.map((t) => [`task.${t}`, 1])),
        // An adversarial test provider says so in public. Buyers don't route on it.
        ...(adversarial ? { adversarial } : {}),
        ...(zgProvider ? { zg_provider: zgProvider } : {}),
        // Listed in the Hashgraph Online agent registry (npm run register:hol): its HCS-10 inbound topic.
        ...(opts.hcs10Inbound ? { hcs10_inbound: opts.hcs10Inbound } : {}),
        // The listed models it serves, queryable one attribute each, and how it isolates them.
        ...Object.fromEntries([...models.keys()].map((k) => [`model.${k}`, 1])),
        ...(opts.sandbox ? { sandbox: opts.sandbox.slice(0, 64) } : {}),
        ...(erc8004 ? { erc8004: erc8004.agentId } : {}),
  });
  const offerPayload = () => ({ name: opts.name, endpoint: url, gpu: opts.gpu, tasks: opts.tasks, backend: opts.backend.name, network: svc.cfg.x402.network, profile, uaid, encKey: encryptionKeyOf(svc.identity.privateKey), ...(adversarial ? { adversarial } : {}), ...(zgProvider ? { zgProvider } : {}), models: [...models.values()].map((m) => ({ key: m.key, id: m.id, version: m.version, runtime: m.backend.name, weightsChecked: !!m.weightsDir })), ...(opts.sandbox ? { sandbox: opts.sandbox } : {}), ...(erc8004 ? { erc8004: { agentId: erc8004.agentId, tx: erc8004.tx, registry: `eip155:${svc.cfg.erc8004.chainId}:${svc.cfg.erc8004.identityRegistry}` } } : {}) });
  const publish = () => svc.arkiv.create({ kind: "offer", ttlSeconds: TTL.offer, attrs: offerAttrs(), payload: offerPayload() });
  let offerKey = await publish();
  log("offer published on Arkiv", { offerKey, price: opts.priceTinybar, bond: bonded, url, uaid });

  // A missed renewal (an RPC outage or rate limit) lets the offer expire; a live node then
  // publishes a fresh one instead of extending a dead entity forever.
  heartbeat = setInterval(() => {
    extendOffer(svc.arkiv, offerKey).catch(async (err: Error) => {
      if (!/expired|not ?found|no ?entity|does not exist/i.test(err.message)) return log("heartbeat failed", { error: err.message });
      try {
        offerKey = await publish();
        log("offer had expired; republished on Arkiv", { offerKey });
      } catch (e) {
        log("republish failed", { error: (e as Error).message });
      }
    });
  }, opts.heartbeatMs ?? 30_000);

  // Newly listed models join the offer as they appear. An Arkiv entity holds at most 32
  // attributes (with app, the `arkiv.schema` tag and the payload), so models stop being added before that.
  const MAX_OFFER_ATTRS = 32 - 3;
  let discovering = false;
  const discover = opts.discoverModels
    ? setInterval(() => {
        if (discovering || !heartbeat) return;
        discovering = true;
        opts.discoverModels!(new Set(models.keys()))
          .then(async (found) => {
            const room = MAX_OFFER_ATTRS - Object.keys(offerAttrs()).length;
            const added = found.slice(0, Math.max(0, room));
            if (found.length > added.length) log("offer is full; not serving more models", { skipped: found.slice(added.length).map((m) => m.id) });
            if (added.length === 0) return;
            for (const m of added) models.set(m.key, m);
            await svc.arkiv.patch(offerKey, offerAttrs(), offerPayload());
            log("now serving newly listed models", { models: added.map((m) => `${m.id}@${m.version}`) });
          })
          .catch((err: Error) => log("model discovery failed", { error: err.message }))
          .finally(() => (discovering = false));
      }, opts.discoverMs ?? 60_000)
    : null;

  function crash() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    server?.closeAllConnections();
    server?.close();
    server = null;
    log("went offline (adversarial outage)");
  }

  return {
    name: opts.name,
    address: svc.address,
    url,
    get offerKey() {
      return offerKey;
    },
    served: () => served,
    close: async () => {
      const wasRunning = server !== null;
      if (discover) clearInterval(discover);
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      if (server) {
        server.closeAllConnections();
        await new Promise((r) => server!.close(r));
        server = null;
      }
      if (wasRunning) await svc.arkiv.remove(offerKey).catch(() => undefined);
    },
  };
}

async function extendOffer(arkiv: ArkivStore, offerKey: string) {
  await arkiv.extend(offerKey, TTL.offer);
}
