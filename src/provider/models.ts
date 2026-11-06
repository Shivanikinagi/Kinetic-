import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Services } from "../integrations/index.js";
import type { ModelCard } from "../models/card.js";
import { verifyModelPassport } from "../models/passport.js";
import { findModels, loadModelPassport, resolveModels, type ModelListing } from "../models/registry.js";
import { scanModelFilesOnDisk, sha256OfFile, type DiskModelFile } from "../models/safetensors.js";
import { downloadWeightFileTo } from "../models/weights.js";
import { logger } from "../util/log.js";
import { OpenAICompatibleBackend, type ModelBackend } from "./backend.js";

// What a provider does before it offers a listed model:
//   1. find the listing on Arkiv, written by one of the bond vault's verifiers;
//   2. download its Model Passport from Swarm and check it: the creator's signature, the malware
//      checks, the benchmark, and a quorum of the vault's verifiers;
//   3. download the weights (when the model has public weights), check every file against the
//      passport's sha256, and run the malware checks again locally before anything loads them;
//   4. optionally import them into its local runtime (Ollama), and run the model from then on.
// A provider never runs a model that fails any of these.

export interface ServedModel {
  key: string;
  id: string;
  version: string;
  card: ModelCard;
  backend: ModelBackend;
  /** Where its checked weights are cached, when the model has public weights. */
  weightsDir?: string;
}

export interface PrepareOptions {
  /** "id@version", "id" (newest version) or a model key, one per model. */
  refs: string[];
  /** The provider's own backend: used when it already runs the model the card names. */
  mainBackend: ModelBackend;
  env?: Record<string, string | undefined>;
  /** Where checked weights are cached (default .kinetic/models). */
  cacheDir?: string;
  /** Builds the backend for a model; the default runs 0G models on 0G and others on PROVIDER_MODEL_URL. */
  backendFor?: (card: ModelCard, main: ModelBackend) => ModelBackend;
}

const run = promisify(execFile);

export async function prepareModels(svc: Services, opts: PrepareOptions): Promise<ServedModel[]> {
  const log = logger("models");
  const env = opts.env ?? process.env;
  const info = await svc.vault.info();
  const served: ServedModel[] = [];
  // One registry query for every model: Arkiv bills reads, and a provider may serve many.
  const listings = await resolveModels(svc.arkiv, info.verifiers, opts.refs);
  for (const listing of listings) {
    const passport = await loadModelPassport(svc.swarm, listing);
    const failed = (await verifyModelPassport(passport, { verifiers: info.verifiers, threshold: info.threshold })).filter((c) => c.ok === false);
    if (failed.length > 0) throw new Error(`${listing.id}@${listing.version}: its Model Passport fails ${failed.map((c) => c.name).join("; ")}`);
    const weightsDir = listing.card.weights ? await fetchCheckedWeights(svc, listing, opts.cacheDir ?? join(".kinetic", "models")) : undefined;
    if (weightsDir && env.PROVIDER_MODEL_IMPORT === "ollama" && listing.card.runtime.engine === "openai") await importIntoOllama(weightsDir, listing.card.runtime.model);
    const backend = (opts.backendFor ?? defaultBackendFor(svc, env))(listing.card, opts.mainBackend);
    served.push({ key: listing.key, id: listing.id, version: listing.version, card: listing.card, backend, ...(weightsDir ? { weightsDir } : {}) });
    log(`serving ${listing.id}@${listing.version} (${listing.key}) on ${backend.name}${weightsDir ? `; weights checked in ${weightsDir}` : ""}`);
  }
  return served;
}

/**
 * Models listed since this provider started that run on 0G Compute (no weights to fetch),
 * checked against their passports like any other. Self-hosted models stay opt-in
 * (PROVIDER_MODELS), since serving one means downloading and running its weights.
 */
export async function discoverModels(svc: Services, known: Set<string>, opts: Omit<PrepareOptions, "refs">): Promise<ServedModel[]> {
  const info = await svc.vault.info();
  const fresh = (await findModels(svc.arkiv, info.verifiers)).filter((l) => l.card.runtime.engine === "0g" && !l.card.weights && !known.has(l.key));
  // One at a time: a model whose passport isn't reachable yet (a fresh Swarm upload) is retried
  // on the next pass without holding up the others.
  const out: ServedModel[] = [];
  for (const l of fresh) {
    try {
      out.push(...(await prepareModels(svc, { ...opts, refs: [l.key] })));
    } catch (err) {
      logger("models")(`not serving ${l.id}@${l.version} yet`, { error: (err as Error).message });
    }
  }
  return out;
}

/** The provider's main backend when it already runs the card's model; otherwise a new one for it. */
export function defaultBackendFor(svc: Services, env: Record<string, string | undefined>) {
  return (card: ModelCard, main: ModelBackend): ModelBackend => {
    const want = `${card.runtime.engine}:${card.runtime.model}`;
    if (main.name === want) return main;
    if (card.runtime.engine === "0g") {
      if (!svc.cfg.zerog.apiKey) throw new Error(`${card.id} runs on 0G: set ZEROG_API_KEY`);
      return new OpenAICompatibleBackend(svc.cfg.zerog.baseUrl, card.runtime.model, svc.cfg.zerog.apiKey, "0g");
    }
    return new OpenAICompatibleBackend(env.PROVIDER_MODEL_URL || "http://localhost:11434/v1", card.runtime.model, env.PROVIDER_MODEL_API_KEY);
  };
}

/** Downloads (or reuses) a model's weights, checks each file's hash and runs the malware checks. */
async function fetchCheckedWeights(svc: Services, listing: ModelListing, cacheRoot: string): Promise<string> {
  const dir = join(cacheRoot, listing.key);
  mkdirSync(dir, { recursive: true });
  const files: DiskModelFile[] = [];
  for (const f of listing.card.weights!.files) {
    const path = join(dir, f.name.replace(/[\\/]/g, "_"));
    // A cached copy is used only if it still matches; otherwise fetched from wherever the card
    // says, straight to disk (weights run to GBs).
    if (!existsSync(path) || (await sha256OfFile(path)) !== f.sha256) await downloadWeightFileTo(listing.card, f, { swarm: svc.swarm, ...(svc.zgStorage ? { zg: svc.zgStorage } : {}) }, path);
    files.push({ name: f.name, path });
  }
  // Checked here again, on the exact bytes this machine will load.
  const scan = await scanModelFilesOnDisk(files);
  if (!scan.ok) throw new Error(`${listing.id}: malware check failed: ${scan.problems.slice(0, 2).join("; ")}`);
  // Ready for `ollama create <model> -f Modelfile`, here or in the sandbox (docker/ollama-sandbox.compose.yml).
  writeFileSync(join(dir, "Modelfile"), "FROM .\n");
  return dir;
}

/** Imports checked safetensors weights into the local Ollama under the card's runtime model name. */
async function importIntoOllama(dir: string, name: string): Promise<void> {
  await run("ollama", ["create", name, "-f", "Modelfile"], { cwd: dir, timeout: 30 * 60_000 });
}
