import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskHash } from "../core/agreement.js";
import type { SwarmClient } from "../integrations/swarm.js";
import type { ZgStorage } from "../integrations/zg-storage.js";
import { downloadWeightFileTo, WeightsFetchError, type WeightStores } from "./weights.js";
import { itemCorrect } from "../tasks/compare.js";
import type { Item, ItemOutput } from "../types.js";
import { canonicalJson, sha256Hex } from "../util/crypto.js";
import { goldFits, goldFor, truthOf, type GoldItem, type GoldSet } from "../verifier/known.js";
import { cardProblems, cardSigner, modelKey, type ModelCard } from "./card.js";
import type { ModelBenchmark, ModelFingerprint, WeightsCheck } from "./passport.js";
import { runInChunks, type ModelRunner } from "./runner.js";
import { scanModelFilesOnDisk, type DiskModelFile } from "./safetensors.js";

// One verifier's own review of a model, before it signs a Model Passport. The lead verifier runs
// it to build the passport; every cosigner runs it again on its own (its own Swarm downloads,
// its own model runs, its own labelled set) and signs only if it reaches the same answers.

export interface PublishRequest {
  card: ModelCard;
  /** The creator's signature over the card. */
  signature: string;
  /** Labelled examples from the creator, used only when the verifiers have none for the task. */
  benchmark?: GoldItem[];
}

export interface ReviewOptions {
  swarm: SwarmClient;
  /** 0G Storage, for weights published there. */
  zg?: () => ZgStorage;
  runner: ModelRunner;
  /** The verifier's labelled sets. */
  gold: GoldSet[];
  /** The task the fingerprint probes belong to, and the probe items. */
  probes?: { task: GoldSet["task"]; items: Item[] } | null;
  minAccuracy: number;
  benchmarkItems?: number;
  maxDownloadBytes?: number;
}

export interface Review {
  key: string;
  weights: WeightsCheck;
  benchmark: ModelBenchmark;
  fingerprint?: ModelFingerprint;
}

export class ModelRejected extends Error {
  readonly status = 400;
  constructor(readonly reasons: string[]) {
    super(`model refused: ${reasons.slice(0, 3).join("; ")}`);
  }
}

export const MIN_CREATOR_BENCHMARK = 8;

/** Labelled items a model is benchmarked on: a stable, per-model sample of the verifier's set, or the creator's own. */
export function benchmarkSet(req: PublishRequest, gold: GoldSet[], n: number): { source: "verifier" | "creator"; items: GoldItem[] } {
  const pool = goldFor(gold, req.card.task);
  const key = modelKey(req.card.id, req.card.version);
  if (pool) {
    const items = [...pool.items].sort((a, b) => sha256Hex(`${key}:${a.id}`).localeCompare(sha256Hex(`${key}:${b.id}`))).slice(0, n);
    return { source: "verifier", items };
  }
  const own = req.benchmark ?? [];
  if (own.length < MIN_CREATOR_BENCHMARK) {
    throw new ModelRejected([`the verifiers have no labelled examples for this task; include at least ${MIN_CREATOR_BENCHMARK} labelled examples with the card`]);
  }
  if (!goldFits({ task: req.card.task, items: own }, req.card.task)) throw new ModelRejected(["the benchmark examples don't fit the card's task"]);
  return { source: "creator", items: own.slice(0, 200) };
}

/**
 * Downloads every weights file the card lists (0G Storage, Swarm or its source) into `dir`,
 * checking each against its sha256. Files go to disk, never wholly into memory: weights run to GBs.
 */
export async function fetchWeights(card: ModelCard, stores: WeightStores, dir: string, maxBytes = 512 * 1024 * 1024): Promise<DiskModelFile[]> {
  const files: DiskModelFile[] = [];
  const total = (card.weights?.files ?? []).reduce((a, f) => a + f.bytes, 0);
  if (total > maxBytes) throw new ModelRejected([`the weights are over the ${Math.round(maxBytes / 1024 / 1024)} MB a verifier downloads`]);
  for (const f of card.weights?.files ?? []) {
    // Plain names only (the card check enforces it); a name can't reach outside `dir`.
    const path = join(dir, f.name.replace(/[\\/]/g, "_"));
    try {
      await downloadWeightFileTo(card, f, stores, path);
    } catch (err) {
      if (err instanceof WeightsFetchError) throw new ModelRejected([err.message]);
      throw err;
    }
    files.push({ name: f.name, path });
  }
  return files;
}

/** The fingerprint probe items: borderline inputs where different models answer differently. */
export function loadProbeItems(path = process.env.FINGERPRINT_CANDIDATES || "data/fingerprint-candidates.jsonl", limit = Number(process.env.MODEL_FINGERPRINT_ITEMS || 24)): Item[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Item)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** Runs every check on a model. Throws ModelRejected with the reasons when it can't be listed. */
export async function reviewModel(req: PublishRequest, opts: ReviewOptions): Promise<Review> {
  const { card } = req;
  const problems = cardProblems(card);
  if (problems.length > 0) throw new ModelRejected(problems);
  if ((await cardSigner(card, req.signature)) !== card.creator.address) throw new ModelRejected(["the card isn't signed by its creator"]);
  const key = modelKey(card.id, card.version);

  // 1. Malware checks on the exact bytes the card lists.
  let weights: WeightsCheck;
  if (card.weights) {
    const dir = await mkdtemp(join(tmpdir(), "kinetic-review-"));
    let scan;
    try {
      scan = await scanModelFilesOnDisk(await fetchWeights(card, { swarm: opts.swarm, ...(opts.zg ? { zg: opts.zg } : {}) }, dir, opts.maxDownloadBytes));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const listed = new Set(card.weights.files.map((f) => f.name));
    if (scan.files.some((f) => !listed.has(f.name))) throw new ModelRejected(["scanned files differ from the card's"]);
    weights = { checked: true, ok: scan.ok, params: scan.params, dtypes: scan.dtypes, files: scan.files, checks: scan.checks };
    if (!scan.ok) throw new ModelRejected(scan.problems.map((p) => `malware check: ${p}`));
  } else {
    weights = { checked: false, reason: `Served by 0G (${card.runtime.model}); its weights aren't published.` };
  }

  // 2. Benchmark on labelled examples, run by this verifier.
  const set = benchmarkSet(req, opts.gold, opts.benchmarkItems ?? 12);
  const { answers, ranOn } = await runInChunks(opts.runner, card.runtime, card.task, set.items.map((g) => ({ id: g.id, text: g.text })));
  const byId = new Map(answers.map((a) => [a.id, a]));
  const correct = set.items.filter((g) => itemCorrect(card.task, truthOf(card.task, g, g.id), byId.get(g.id))).length;
  const accuracy = set.items.length ? correct / set.items.length : 0;
  const benchmark: ModelBenchmark = {
    task: taskHash(card.task),
    source: set.source,
    items: set.items.length,
    itemsHash: sha256Hex(canonicalJson(set.source === "verifier" ? set.items.map((g) => g.id) : set.items)),
    correct,
    accuracy,
    minAccuracy: opts.minAccuracy,
    ranOn,
  };
  if (accuracy < opts.minAccuracy) throw new ModelRejected([`benchmark ${correct}/${set.items.length} (${Math.round(accuracy * 100)}%) is below the ${Math.round(opts.minAccuracy * 100)}% listing bar`]);

  // 3. Fingerprint: its answers on borderline probe items, when the task has them. Run twice and
  //    keep only the answers it gives both times: a borderline item a model answers differently
  //    from run to run would count against an honest provider later.
  let fingerprint: ModelFingerprint | undefined;
  if (opts.probes && opts.probes.items.length >= 3 && goldFits({ task: opts.probes.task, items: [{ id: "x", text: "x" }] }, card.task)) {
    const labels = (answers: ItemOutput[]) => new Map(answers.filter((a): a is ItemOutput & { label: string } => !!a.label).map((a) => [a.id, a.label]));
    const first = labels((await runInChunks(opts.runner, card.runtime, card.task, opts.probes.items)).answers);
    const second = labels((await runInChunks(opts.runner, card.runtime, card.task, opts.probes.items)).answers);
    fingerprint = { task: taskHash(opts.probes.task), answers: Object.fromEntries([...first].filter(([id, label]) => second.get(id) === label)) };
  }
  return { key, weights, benchmark, ...(fingerprint ? { fingerprint } : {}) };
}

/**
 * A cosigner's verdict on the lead's review: the same weights and files, a benchmark within
 * `tolerance` on the same items, and a fingerprint that mostly matches. Returns the reasons it disagrees.
 */
export function compareReviews(lead: Review, mine: Review, tolerance = 0.1): string[] {
  const reasons: string[] = [];
  if (lead.key !== mine.key) reasons.push("a different model");
  if (lead.weights.checked !== mine.weights.checked) reasons.push("the weights check differs");
  else if (lead.weights.checked && mine.weights.checked) {
    const files = (w: typeof mine.weights) => (w.checked ? w.files.map((f) => `${f.name}:${f.sha256}`).sort().join(",") : "");
    if (files(lead.weights) !== files(mine.weights)) reasons.push("the scanned files differ");
    if (lead.weights.params !== mine.weights.params) reasons.push("the parameter count differs");
    if (!mine.weights.ok) reasons.push("the malware checks failed here");
  }
  if (lead.benchmark.itemsHash !== mine.benchmark.itemsHash) reasons.push("the benchmark used different items");
  else if (Math.abs(lead.benchmark.accuracy - mine.benchmark.accuracy) > tolerance) reasons.push(`benchmark ${Math.round(mine.benchmark.accuracy * 100)}% here, ${Math.round(lead.benchmark.accuracy * 100)}% claimed`);
  if (!!lead.fingerprint !== !!mine.fingerprint) reasons.push("one review has a fingerprint and the other doesn't");
  else if (lead.fingerprint && mine.fingerprint) {
    // Compared on the items both found stable: each review keeps only answers it got twice.
    const ids = Object.keys(lead.fingerprint.answers).filter((id) => id in mine.fingerprint!.answers);
    const same = ids.filter((id) => mine.fingerprint!.answers[id] === lead.fingerprint!.answers[id]).length;
    if (ids.length < 3 || same / ids.length < 0.75) reasons.push(`fingerprint matched ${same} of ${ids.length} answers`);
  }
  return reasons;
}
