import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { BuyerAgent, choiceFromEnv, type BuyerPolicy, type JobReport } from "../agent/buyer.js";
import type { AgreementInput } from "../core/agreement.js";
import type { Tier } from "../core/tiers.js";
import { loadNetworkConfig } from "../config.js";
import { connect, type Services } from "../integrations/index.js";
import { TESTNET } from "../networks.js";
import { TINYBARS_PER_HBAR, type Item, type Offer, type TaskKind, type TaskSpec } from "../types.js";
import { findModels, loadModelPassport, resolveModel, type ModelListing } from "../models/registry.js";
import { verifyModelPassport, type ModelPassport } from "../models/passport.js";
import { publishModel, type PublishInput, type PublishResult } from "../models/publish.js";
import type { Check } from "../agent/passport.js";

// KINETIC for applications: run a batch AI job on community GPUs from your own code. This is a
// thin wrapper over the buyer agent. It runs in your process, with your key: chunks are
// encrypted before they leave, you pay each chunk yourself, and refunds come back to you.
// Node only: it holds a private key that pays.

export type { JobReport, Offer, TaskSpec, Item, AgreementInput, Tier, ModelListing, ModelPassport, PublishInput, PublishResult };

/** Tinybar as a bigint, or HBAR as text: "0.5", "0.5 HBAR", "0.5 ℏ". */
export type Amount = bigint | string;

export interface KineticOptions {
  /** Your secp256k1 key: your Hedera ECDSA account, Arkiv wallet and payment signer. */
  privateKey: Hex;
  /** Your Hedera account id (0.0.x). Required on testnet. */
  hederaAccountId?: string;
  /** The verifier jobs register with. Default: the network's. */
  verifierUrl?: string;
  hcsTopicId?: string;
  vaultAddress?: Hex;
  /** Arkiv access key (hub.arkiv.network/access-keys): lifts the public RPC's rate limit. */
  arkivApiKey?: string;
  /** Spending limits. Defaults: 0.005 ℏ per chunk, 0.5 ℏ per job. */
  budget?: { maxPricePerChunk?: Amount; maxJobSpend?: Amount };
  /** How providers are chosen. */
  choice?: Pick<BuyerPolicy, "strategy" | "maxProviders" | "minReliability" | "requireAttestation" | "allowlist">;
  /** Everything the agent does as it happens: admission, payments, canaries, slashes, reroutes. */
  onEvent?: (event: KineticEvent) => void;
  /** Any other KINETIC setting by its .env name (e.g. ARKIV_RPC_URL). Used instead of process.env. */
  settings?: Record<string, string | undefined>;
}

export interface KineticEvent {
  at: number;
  message: string;
  fields?: Record<string, unknown>;
}

export interface RunOptions {
  /**
   * A listed model to run: "namespace/name", "namespace/name@1.0.0" or its key. The model's card
   * sets the task; only providers serving it are used, and its creator is paid a royalty.
   */
  model?: string;
  /** A built-in task by name (see Kinetic.tasks()), or your own task definition. Not needed with `model`. */
  task?: string | TaskSpec;
  /** The most this job may cost, overriding the default budget: tinybar, or "0.5 HBAR". */
  budget?: Amount;
  /** The records to process. Plain strings get ids "1", "2", … */
  items: (Item | string)[];
  /** Items per chunk (and per payment). Default 5. */
  chunkSize?: number;
  /** Your rules for the job, locked in on HCS before any work runs. */
  agreement?: AgreementInput;
  /** Called with the job id as soon as it exists. */
  onJob?: (jobId: string) => void;
}

export interface BuiltInTask {
  name: string;
  kind: TaskKind;
  /** The verifier has labelled examples for it: a provider that gets them wrong can be slashed. */
  knownAnswers: boolean;
  spec: TaskSpec;
}

const DATA_DIR = fileURLToPath(new URL("../../data/", import.meta.url));

/** The tasks KINETIC ships with: data/*.task.json and every folder in data/tasks/. */
export function builtInTasks(dataDir = DATA_DIR): BuiltInTask[] {
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as TaskSpec;
  const files = readdirSync(dataDir)
    .filter((f) => f.endsWith(".task.json"))
    .map((f) => {
      const name = f.replace(".task.json", "");
      // The original ticket set's labelled examples are data/gold-tickets.jsonl.
      return { name, spec: read(join(dataDir, f)), knownAnswers: name === "classify-tickets" && existsSync(join(dataDir, "gold-tickets.jsonl")) };
    });
  const tasksDir = join(dataDir, "tasks");
  const folders = existsSync(tasksDir)
    ? readdirSync(tasksDir)
        .filter((d) => existsSync(join(tasksDir, d, "task.json")))
        .map((d) => ({ name: d, spec: read(join(tasksDir, d, "task.json")), knownAnswers: existsSync(join(tasksDir, d, "gold.jsonl")) }))
    : [];
  return [...files, ...folders].map((t) => ({ ...t, kind: t.spec.kind }));
}

/** Parses an Amount to tinybar. */
export function toTinybar(amount: Amount): bigint {
  if (typeof amount === "bigint") return amount;
  const text = amount.trim().replace(/\s*(HBAR|hbar|ℏ)$/, "");
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(text);
  if (!match) throw new Error(`not an HBAR amount: ${amount}`);
  return BigInt(match[1]) * TINYBARS_PER_HBAR + BigInt((match[2] ?? "").padEnd(8, "0"));
}

/** The same task: kind, label names and field names, whatever the wording. */
const shape = (t: TaskSpec) => JSON.stringify([t.kind, (t.labels ?? []).map((l) => l.name).sort(), (t.fields ?? []).map((f) => f.name).sort()]);

export class Kinetic {
  readonly svc: Services;
  readonly verifierUrl: string;
  private readonly policy: BuyerPolicy;
  private readonly running = new Set<BuyerAgent>();
  private halted = false;

  constructor(private readonly opts: KineticOptions) {
    const settings = opts.settings ?? {};
    const cfg = loadNetworkConfig({
      ...settings,
      HCS_TOPIC_ID: opts.hcsTopicId ?? settings.HCS_TOPIC_ID ?? TESTNET.hcsTopicId,
      BOND_VAULT_ADDRESS: opts.vaultAddress ?? settings.BOND_VAULT_ADDRESS ?? TESTNET.vaultAddress,
      ARKIV_API_KEY: opts.arkivApiKey ?? settings.ARKIV_API_KEY,
    });
    this.svc = connect(cfg, { privateKey: opts.privateKey, hederaAccountId: opts.hederaAccountId });
    this.verifierUrl = (opts.verifierUrl ?? settings.VERIFIER_URL ?? TESTNET.verifierUrl).replace(/\/$/, "");
    this.policy = {
      maxPricePerChunk: toTinybar(opts.budget?.maxPricePerChunk ?? 500_000n),
      maxJobSpend: toTinybar(opts.budget?.maxJobSpend ?? 50_000_000n),
      ...opts.choice,
    };
  }

  /** From KINETIC_PRIVATE_KEY, HEDERA_ACCOUNT_ID, VERIFIER_URL, AGENT_* and the rest of a KINETIC .env. */
  static fromEnv(env: Record<string, string | undefined> = process.env, extra: Pick<KineticOptions, "onEvent"> = {}): Kinetic {
    const key = env.KINETIC_PRIVATE_KEY;
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("KINETIC_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key (run `npm run kinetic -- init`)");
    return new Kinetic({
      privateKey: key as Hex,
      hederaAccountId: env.HEDERA_ACCOUNT_ID,
      budget: {
        ...(env.AGENT_MAX_PRICE_TINYBAR ? { maxPricePerChunk: BigInt(env.AGENT_MAX_PRICE_TINYBAR) } : {}),
        ...(env.AGENT_MAX_JOB_SPEND_TINYBAR ? { maxJobSpend: BigInt(env.AGENT_MAX_JOB_SPEND_TINYBAR) } : {}),
      },
      choice: { ...choiceFromEnv(env), allowlist: env.AGENT_ALLOWLIST?.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean) || undefined },
      settings: env,
      ...extra,
    });
  }

  /** Your EVM address: your Arkiv identity and the address refunds go to. */
  get address(): string {
    return this.svc.address;
  }

  static tasks(): BuiltInTask[] {
    return builtInTasks();
  }

  /** Bonded providers that can run this kind of task within your price limit, best first. */
  async providers(kind: TaskKind = "classify", tier: Tier = "standard"): Promise<Offer[]> {
    return this.agent().discover(kind, tier);
  }

  /**
   * Runs a job to the end: splits, encrypts, pays per chunk, verifies, reroutes and settles.
   * The report has the results, what you paid and got refunded, and the Compute Passport.
   */
  async run(input: RunOptions): Promise<JobReport> {
    if (this.halted) throw new Error("KINETIC is halted: call resume() first");
    const model = input.model ? await this.model(input.model) : undefined;
    if (!model && input.task === undefined) throw new Error("name a task or a model to run");
    const task = model ? model.card.task : this.resolveTask(input.task!);
    const items = input.items.map((item, i) => (typeof item === "string" ? { id: String(i + 1), text: item } : item));
    if (items.length === 0) throw new Error("no items to process");
    const agent = this.agent(input.budget === undefined ? undefined : toTinybar(input.budget));
    this.running.add(agent);
    try {
      return await agent.run({ task, items, chunkSize: input.chunkSize ?? 5, agreement: input.agreement, ...(model ? { model } : {}) }, { onJob: input.onJob });
    } finally {
      this.running.delete(agent);
    }
  }

  /** Every model listed by the bond vault's verifiers, each with a quorum-signed Model Passport. */
  async models(): Promise<ModelListing[]> {
    return findModels(this.svc.arkiv, (await this.svc.vault.info()).verifiers);
  }

  /** One listed model: "namespace/name" (newest version), "namespace/name@1.0.0" or its key. */
  async model(ref: string): Promise<ModelListing> {
    return resolveModel(this.svc.arkiv, (await this.svc.vault.info()).verifiers, ref);
  }

  /** A listed model's Model Passport from 0G Storage, and every check on it (card, creator, malware checks, benchmark, quorum). */
  async passport(ref: string): Promise<{ listing: ModelListing; passport: ModelPassport; checks: Check[] }> {
    const listing = await this.model(ref);
    const passport = await loadModelPassport(this.svc.storage, listing);
    const info = await this.svc.vault.info();
    return { listing, passport, checks: await verifyModelPassport(passport, { verifiers: info.verifiers, threshold: info.threshold }) };
  }

  /**
   * Publishes a model: malware checks here first, weights to 0G Storage, a signed card, and the
   * listing fee to the verifier, which reviews it with the other verifiers and lists it.
   */
  async publish(input: PublishInput): Promise<PublishResult> {
    return publishModel(this.svc, this.verifierUrl, input, (message) => this.opts.onEvent?.({ at: Date.now(), message }));
  }

  /** Kill switch: no new paid work starts, in running jobs or new ones. Chunks in flight finish. */
  halt(): void {
    this.halted = true;
    for (const agent of this.running) agent.halt();
  }

  resume(): void {
    this.halted = false;
  }

  private agent(maxJobSpend?: bigint): BuyerAgent {
    const onEvent = this.opts.onEvent;
    const policy = maxJobSpend === undefined ? this.policy : { ...this.policy, maxJobSpend };
    return new BuyerAgent(this.svc, this.verifierUrl, policy, (message, fields) => onEvent?.({ at: Date.now(), message, fields }));
  }

  private resolveTask(task: string | TaskSpec): TaskSpec {
    const builtIn = builtInTasks();
    if (typeof task === "string") {
      const found = builtIn.find((t) => t.name === task);
      if (!found) throw new Error(`unknown task ${task}; built-in tasks: ${builtIn.map((t) => t.name).join(", ")}`);
      return found.spec;
    }
    if (!builtIn.some((t) => t.knownAnswers && shape(t.spec) === shape(task))) {
      this.opts.onEvent?.({
        at: Date.now(),
        message: "custom task: the verifier has no labelled examples for it, so results get format and model checks only and no provider can be slashed for wrong answers",
      });
    }
    return task;
  }
}
