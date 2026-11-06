import { recoverMessageAddress, type Hex, type LocalAccount } from "viem";
import type { TaskSpec } from "../types.js";
import { canonicalJson, sha256Hex } from "../util/crypto.js";

// A model card: what a creator publishes. It names the model and its exact version, the task it
// does (labels or fields, so a buyer knows what comes back), what providers must run, where the
// weights are and their hashes, the licence, and the creator's royalty. The creator signs it, so
// nobody else can list a model in their name or redirect its royalties, and the terms are fixed
// per version: a new royalty means a new version.

export const MODEL_CARD_KIND = "kinetic.model.v1";

/** Royalties are capped at 30% of what the providers are paid. */
export const MAX_ROYALTY_BPS = 3000;

/**
 * What providers run. `0g`: a model served by 0G Compute (its weights aren't downloadable).
 * `openai`: an OpenAI-compatible server on the provider's own GPU (Ollama, vLLM, …), loaded
 * from the card's weights.
 */
export interface ModelRuntime {
  engine: "0g" | "openai";
  /** The model name the runtime serves, e.g. "0gm-1.0-35b-a3b" or "qwen2.5:3b-instruct". */
  model: string;
}

export interface ModelWeightsFile {
  name: string;
  sha256: string;
  bytes: number;
  /** Public (unencrypted) Swarm reference to the file. */
  swarmRef?: string;
  /** 0G Storage root hash of the file (0x + 64 hex), for weights stored on 0G. */
  zgRoot?: string;
}

export interface ModelCard {
  kind: typeof MODEL_CARD_KIND;
  /** "namespace/name", lower-case. */
  id: string;
  version: string;
  name: string;
  description: string;
  /** SPDX licence id, e.g. "apache-2.0". */
  license: string;
  creator: {
    /** The creator's EVM address: it signs the card. */
    address: string;
    /** Where royalties are paid: a Hedera account id on testnet. */
    payTo: string;
  };
  /** What the model does and what it returns. */
  task: TaskSpec;
  runtime: ModelRuntime;
  /** Absent for models served by 0G, whose weights aren't public. */
  weights?: { format: "safetensors"; files: ModelWeightsFile[]; source?: string };
  /** Creator's share of every accepted chunk payment, in basis points (500 = 5%). */
  royaltyBps: number;
  createdAt: string;
}

/** The card's short id for one version: `m` + 15 hex. Usable as an Arkiv attribute name. */
export function modelKey(id: string, version: string): string {
  return `m${sha256Hex(`${id}@${version}`).slice(0, 15)}`;
}

export const isModelKey = (s: string) => /^m[0-9a-f]{15}$/.test(s);

export const cardDigest = (card: ModelCard) => sha256Hex(canonicalJson(card));

const message = (card: ModelCard) => `${MODEL_CARD_KIND}:${cardDigest(card)}`;

export function signCard(account: LocalAccount, card: ModelCard): Promise<Hex> {
  return account.signMessage({ message: message(card) });
}

export async function cardSigner(card: ModelCard, signature: string): Promise<string | null> {
  try {
    return (await recoverMessageAddress({ message: message(card), signature: signature as Hex })).toLowerCase();
  } catch {
    return null;
  }
}

/** Problems with a card, empty when it can be listed. */
export function cardProblems(card: ModelCard): string[] {
  const p: string[] = [];
  if (!card || card.kind !== MODEL_CARD_KIND) return [`not a ${MODEL_CARD_KIND} card`];
  if (!/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9._-]{0,63}$/.test(card.id ?? "")) p.push('id must look like "namespace/name" (lower-case letters, digits, - . _)');
  if (!/^\d+\.\d+\.\d+(-[0-9a-z.-]+)?$/.test(card.version ?? "")) p.push("version must be semantic, e.g. 1.0.0");
  if (typeof card.name !== "string" || !card.name.trim() || card.name.length > 80) p.push("name is required (at most 80 characters)");
  if (typeof card.description !== "string" || card.description.length > 2000) p.push("description is at most 2000 characters");
  if (typeof card.license !== "string" || !/^[A-Za-z0-9.+-]{2,40}$/.test(card.license)) p.push("license must be an SPDX id, e.g. apache-2.0");
  if (!/^0x[0-9a-f]{40}$/.test(card.creator?.address ?? "")) p.push("creator.address must be a lower-case EVM address");
  if (!card.creator?.payTo || card.creator.payTo.length > 64) p.push("creator.payTo is required");
  if (!card.task || !["classify", "extract", "tag"].includes(card.task.kind) || typeof card.task.instructions !== "string") p.push("task must be a classify, extract or tag task");
  else if (card.task.kind !== "extract" && !(card.task.labels?.length ?? 0)) p.push("a classify or tag task needs labels");
  else if (card.task.kind === "extract" && !(card.task.fields?.length ?? 0)) p.push("an extract task needs fields");
  if (!card.runtime || !["0g", "openai"].includes(card.runtime.engine) || !/^[A-Za-z0-9._:/-]{1,100}$/.test(card.runtime.model ?? "")) p.push("runtime must name an engine (0g or openai) and a model");
  if (!Number.isInteger(card.royaltyBps) || card.royaltyBps < 0 || card.royaltyBps > MAX_ROYALTY_BPS) p.push(`royaltyBps must be an integer from 0 to ${MAX_ROYALTY_BPS}`);
  if (Number.isNaN(Date.parse(card.createdAt ?? ""))) p.push("createdAt must be a date");
  if (card.runtime?.engine === "openai" && !card.weights) p.push("a model that providers run themselves needs its weights");
  if (card.weights) {
    if (card.weights.format !== "safetensors") p.push("weights must be safetensors");
    const files = card.weights.files ?? [];
    if (files.length === 0 || files.length > 64) p.push("weights must list 1 to 64 files");
    for (const f of files) {
      if (!f.name || !/^[0-9a-f]{64}$/.test(f.sha256 ?? "") || !Number.isSafeInteger(f.bytes) || f.bytes < 0) p.push(`weights file ${f.name || "?"} needs a name, sha256 and size`);
      if (f.swarmRef !== undefined && !/^[0-9a-f]{64}$/.test(f.swarmRef)) p.push(`weights file ${f.name} has a bad Swarm reference (public, 64 hex)`);
      if (f.zgRoot !== undefined && !/^0x[0-9a-f]{64}$/.test(f.zgRoot)) p.push(`weights file ${f.name} has a bad 0G Storage root (0x + 64 hex)`);
    }
    if (files.some((f) => !f.swarmRef && !f.zgRoot) && !card.weights.source) p.push("every weights file needs a 0G Storage root, a Swarm reference or a source to download it from");
  }
  return p;
}

/** "kinetic/ticket-classifier@1.0.0" or "kinetic/ticket-classifier" → id and optional version. */
export function parseModelRef(ref: string): { id: string; version?: string } {
  const at = ref.lastIndexOf("@");
  return at > 0 ? { id: ref.slice(0, at), version: ref.slice(at + 1) } : { id: ref };
}

/** Compares two semantic versions, for picking the newest. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x).localeCompare(String(y));
  }
  return 0;
}
