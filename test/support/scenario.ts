import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { publishModel, type PublishResult } from "../../src/models/publish.js";
import { resolveModel, type ModelListing } from "../../src/models/registry.js";
import type { ModelRunner } from "../../src/models/runner.js";
import { buildSafetensors } from "../../src/models/safetensors.js";
import { prepareModels } from "../../src/provider/models.js";
import { BuyerAgent, type BuyerPolicy, type JobReport } from "../../src/agent/buyer.js";
import { loadJob } from "../../src/agent/report.js";
import type { AgreementInput } from "../../src/core/agreement.js";
import { loadNetworkConfig } from "../../src/config.js";
import { startDevnet, type Devnet, type DevnetOptions } from "./devnet.js";
import { ZeroGComputeBackend, zeroGComputeClient } from "../../src/integrations/zerog-compute.js";
import { connect, connectCosigner, type Services } from "../../src/integrations/index.js";
import { Cosigner } from "../../src/verifier/cosigner.js";
import { parseBehavior, type ModelBackend } from "../../src/provider/backend.js";
import { HeuristicBackend, heuristicRun } from "./heuristic.js";
import { readReceipts } from "../../src/integrations/hcs.js";
import { startProvider, type RunningProvider } from "../../src/provider/node.js";
import { startVerifier } from "../../src/verifier/service.js";

// Test harness only: the whole system on the devnet emulator, so the suites run fast and free.
// Five providers (two honest; three adversarial: one passes admission then cuts corners, one
// goes down mid-job, one fails admission outright), the verifier, and a buyer agent.

export interface ScenarioOptions {
  basePort?: number;
  chunkSize?: number;
  canaryRate?: number;
  /** Override the slash threshold, e.g. to exercise quarantine without a slash. */
  failLimit?: number;
  taskPath?: string;
  itemsPath?: string;
  /** Provider choice: strategy, how many providers work at once, reliability floor. */
  choice?: Pick<BuyerPolicy, "strategy" | "maxProviders" | "minReliability">;
  /** The buyer's rules for the job (check rate, pass mark, own examples, deadline). */
  agreement?: AgreementInput;
  /** Providers that ask for their bond back before the job starts. */
  withdrawing?: string[];
  /**
   * The vault's verifier quorum: the lead plus `cosigners` more, `threshold` of them needed to
   * slash. `lenient` cosigners never confirm a failure (they sign nothing). Default: the lead alone.
   */
  quorum?: { cosigners: number; threshold?: number; lenient?: number };
  /** Seconds a slash stays open to dispute before it executes (default 0). */
  disputeWindowSeconds?: number;
  /** Seconds the verifiers have to decide a dispute before it is cancelled. */
  resolveTimeoutSeconds?: number;
  /** Providers that dispute any slash against them as soon as it is proposed. */
  disputing?: string[];
  /** The 0G reference model disagrees with every honest answer. */
  referenceDisagrees?: boolean;
  /** Plant known answers in every chunk (default on, as on testnet). */
  plantKnown?: boolean;
  /** Let model disagreement count toward slashing (CANARY_MODEL_SLASHES). */
  modelSlashes?: boolean;
  /** Chunks re-run on 0G after the job, picked by a PRNG seed drawn in the vault (SPOT_CHECKS; default 0 on devnet). */
  spotChecks?: number;
  /**
   * Providers call the devnet's 0G Compute providers directly instead of a local model: atlas,
   * nimbus and cheapo on one each, flicker on the same one as atlas; shoddy calls no model.
   */
  zeroG?: {
    zgProviders?: DevnetOptions["zgProviders"];
    /** Providers that make a real 0G call, then change the answer before returning it (after admission). */
    tamper?: string[];
  };
  /**
   * The model hub: a creator publishes a model with safetensors weights (reviewed by the verifier
   * quorum), the providers named in `serve` (default all) load it after checking its passport and
   * weights, and the buyer runs the job on that model and pays the creator's royalty.
   */
  modelHub?: { royaltyBps?: number; serve?: string[]; storage?: "0g" | "swarm" };
}

export interface Scenario {
  report: JobReport;
  devnet: Devnet;
  verifierUrl: string;
  buyer: string;
  buyerSvc: Services;
  providers: RunningProvider[];
  balances: { buyerBefore: bigint; buyerAfter: bigint; creatorBefore?: bigint; creatorAfter?: bigint };
  /** With modelHub: the creator, what publishing returned, and the listing the buyer ran. */
  hub?: { creator: Services; published: PublishResult; listing: ModelListing };
  close: () => Promise<void>;
}

const PROVIDERS = [
  { name: "atlas-4090", gpu: "RTX 4090", price: 100_000n, behavior: "honest" },
  { name: "nimbus-a100", gpu: "A100 80GB", price: 120_000n, behavior: "honest" },
  { name: "cheapo-3060", gpu: "RTX 3060", price: 60_000n, behavior: "degrade-after:1" },
  { name: "flicker-t4", gpu: "T4", price: 80_000n, behavior: "offline-after:4" },
  { name: "shoddy-1060", gpu: "GTX 1060", price: 40_000n, behavior: "lazy" },
] as const;

/**
 * A provider that really calls its 0G provider, then rewrites every label before returning.
 * Its first chunk (the admission probe) is left alone, so it gets paid work.
 */
function tampering(inner: ZeroGComputeBackend): ModelBackend {
  let runs = 0;
  return {
    name: inner.name,
    zgProvider: inner.zgProvider,
    run: (task, items) => inner.run(task, items),
    async runWithEvidence(task, items) {
      const out = await inner.runWithEvidence(task, items);
      if (runs++ === 0) return out;
      const other = (label?: string) => task.labels?.find((l) => l.name !== label)?.name;
      return { ...out, result: { items: out.result.items.map((i) => ({ ...i, label: other(i.label) })) } };
    },
  };
}

/** A cosigner that confirms nothing: it refuses every slash and votes to overturn every dispute. */
function lenient(c: Cosigner): Cosigner {
  return Object.assign(Object.create(Object.getPrototypeOf(c)), c, {
    review: async () => ({ ok: false, confirmed: 0, reasons: ["lenient test cosigner"] }),
  }) as Cosigner;
}

/** Verifiers run a self-hosted model the way the test providers do: the keyword model. */
export const heuristicRunner: ModelRunner = { run: async (_runtime, task, items) => ({ result: heuristicRun(task, items), ranOn: "self-hosted:heuristic" }) };

/** A tiny but real safetensors model, with a config: what a creator uploads in the tests. */
export function tinyModelFiles() {
  return [
    { name: "model.safetensors", bytes: buildSafetensors({ "embed.weight": { shape: [4, 3], values: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2] }, "head.bias": { shape: [3], values: [0, 0.5, -0.5] } }, { format: "pt" }) },
    { name: "config.json", bytes: new TextEncoder().encode(JSON.stringify({ architectures: ["TinyClassifier"], hidden_size: 3 })) },
  ];
}

/** Which devnet 0G Compute provider each of PROVIDERS runs on, with opts.zeroG. */
const UPSTREAM = [0, 1, 2, 0, undefined] as const;

export async function runScenario(opts: ScenarioOptions = {}): Promise<Scenario> {
  const basePort = opts.basePort ?? 4400;
  const devnet = await startDevnet({
    port: basePort,
    disputeWindowSeconds: opts.disputeWindowSeconds ?? 0,
    referenceDisagrees: opts.referenceDisagrees,
    ...(opts.resolveTimeoutSeconds !== undefined ? { resolveTimeoutSeconds: opts.resolveTimeoutSeconds } : {}),
    ...(opts.zeroG?.zgProviders ? { zgProviders: opts.zeroG.zgProviders } : {}),
  });
  // Only policy settings come from the environment: a testnet .env must not point the devnet
  // scenario at real facilitators, mirror nodes or 0G.
  const policyEnv = Object.fromEntries(
    ["CANARY_WINDOW", "CANARY_FAIL_LIMIT", "CANARY_MIN_AGREEMENT", "CANARY_MIN", "VERIFIER_FEE_PER_CHUNK_TINYBAR"].map((k) => [k, process.env[k]]),
  );
  const cfg = loadNetworkConfig({
    ...policyEnv,
    KINETIC_NETWORK: "devnet",
    DEVNET_URL: devnet.url,
    CANARY_RATE: String(opts.canaryRate ?? 0.5),
    ...(opts.failLimit ? { CANARY_FAIL_LIMIT: String(opts.failLimit) } : {}),
    ...(opts.plantKnown === false ? { KNOWN_ANSWERS: "false" } : {}),
    ...(opts.modelSlashes ? { CANARY_MODEL_SLASHES: "true" } : {}),
    ...(opts.spotChecks ? { SPOT_CHECKS: String(opts.spotChecks) } : {}),
  });

  const verifierSvc = connect(cfg, { privateKey: generatePrivateKey() });
  // The other verifiers: each its own key and 0G client, re-checking every slash before it signs.
  const cosigners: Cosigner[] = [];
  for (let i = 0; i < (opts.quorum?.cosigners ?? 0); i++) {
    const c = new Cosigner({ ...connectCosigner(cfg, { privateKey: generatePrivateKey() }), runner: heuristicRunner });
    cosigners.push(i < (opts.quorum?.lenient ?? 0) ? lenient(c) : c);
  }
  devnet.setVerifiers([verifierSvc.address, ...cosigners.map((c) => c.address)], opts.quorum?.threshold);
  // The verifier pays for qualification probes out of its fees.
  devnet.fund(verifierSvc.address, 100_000_000n);
  const verifier = await startVerifier(verifierSvc, basePort + 100, { cosigners, modelRunner: heuristicRunner });

  // The model hub: a creator publishes before the providers start, so they can load the model.
  const { task, items } = loadJob(opts.taskPath ?? "data/classify-tickets.task.json", opts.itemsPath ?? "data/tickets.jsonl");
  let hub: { creator: Services; published: PublishResult } | undefined;
  if (opts.modelHub) {
    const creator = connect(cfg, { privateKey: generatePrivateKey() });
    devnet.fund(creator.address, 100_000_000n);
    const published = await publishModel(creator, verifier.url, {
      card: {
        id: "kinetic/ticket-classifier",
        version: "1.0.0",
        name: "Support ticket classifier",
        description: "Routes support tickets to billing, bug, account or other.",
        license: "apache-2.0",
        task,
        runtime: { engine: "openai", model: "heuristic" },
        royaltyBps: opts.modelHub.royaltyBps ?? 500,
      },
      files: tinyModelFiles(),
      ...(opts.modelHub.storage ? { storage: opts.modelHub.storage } : {}),
    });
    hub = { creator, published };
  }
  const creatorBefore = hub ? devnet.balanceOf(hub.creator.address) : undefined;
  const modelCache = mkdtempSync(join(tmpdir(), "kinetic-models-"));

  const providers: RunningProvider[] = [];
  const disputers = new Map<string, Services>();
  for (const [i, p] of PROVIDERS.entries()) {
    const svc = connect(cfg, { privateKey: generatePrivateKey() });
    devnet.fund(svc.address, 2_000_000_000n);
    const upstream = opts.zeroG ? UPSTREAM[i] : undefined;
    const direct = upstream === undefined ? undefined : await new ZeroGComputeBackend(zeroGComputeClient(cfg), devnet.zgProviders[upstream]).init();
    const backend = !direct ? new HeuristicBackend() : opts.zeroG?.tamper?.includes(p.name) ? tampering(direct) : direct;
    // Each serving provider checks the passport and the weights before it offers the model.
    const serves = hub && (opts.modelHub?.serve ?? PROVIDERS.map((x) => x.name)).includes(p.name);
    const models = serves ? await prepareModels(svc, { refs: [hub!.published.id], mainBackend: backend, backendFor: (_card, main) => main, cacheDir: modelCache }) : undefined;
    providers.push(
      await startProvider(
        {
          name: p.name,
          port: basePort + 701 + i,
          gpu: p.gpu,
          tasks: ["classify", "extract", "tag"],
          priceTinybar: p.price,
          bondTinybar: 100_000_000n,
          backend,
          behavior: parseBehavior(p.behavior),
          ...(models ? { models } : {}),
        },
        svc,
      ),
    );
    if (opts.withdrawing?.includes(p.name)) await svc.vault.requestWithdraw();
    if (opts.disputing?.includes(p.name)) disputers.set(svc.address, svc);
  }

  // A disputing provider watches HCS for a slash against it and challenges it at once.
  const disputed = new Set<string>();
  const watcher =
    disputers.size === 0
      ? undefined
      : setInterval(async () => {
          const receipts = await readReceipts({ mirrorUrl: `${devnet.url}/mirror`, hcsTopicId: cfg.hedera.hcsTopicId, jsonRpcUrl: "" }, 1000).catch(() => []);
          for (const { receipt: r } of receipts) {
            if (r.t !== "slash" || !r.slashId || disputed.has(r.slashId) || !disputers.has(r.provider)) continue;
            disputed.add(r.slashId);
            await disputers
              .get(r.provider)!
              .vault.dispute(r.slashId as `0x${string}`, 10_000_000n)
              .catch(() => disputed.delete(r.slashId!));
          }
        }, 150);

  const buyerSvc = connect(cfg, { privateKey: generatePrivateKey() });
  devnet.fund(buyerSvc.address, 1_000_000_000n);
  const buyerBefore = devnet.balanceOf(buyerSvc.address);
  const agent = new BuyerAgent(buyerSvc, verifier.url, { maxPricePerChunk: 500_000n, maxJobSpend: 50_000_000n, ...opts.choice });

  const listing = hub ? await resolveModel(buyerSvc.arkiv, (await buyerSvc.vault.info()).verifiers, hub.published.id) : undefined;
  const report = await agent.run({ task, items, chunkSize: opts.chunkSize ?? 3, agreement: opts.agreement, ...(listing ? { model: listing } : {}) });

  return {
    report,
    devnet,
    verifierUrl: verifier.url,
    buyer: buyerSvc.address,
    buyerSvc,
    providers,
    balances: { buyerBefore, buyerAfter: devnet.balanceOf(buyerSvc.address), ...(hub ? { creatorBefore, creatorAfter: devnet.balanceOf(hub.creator.address) } : {}) },
    ...(hub && listing ? { hub: { ...hub, listing } } : {}),
    close: async () => {
      clearInterval(watcher);
      for (const p of providers) await p.close();
      await verifier.close();
      await devnet.close();
    },
  };
}
