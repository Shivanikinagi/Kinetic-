import type { Services } from "../integrations/index.js";
import { payFetch } from "../integrations/x402.js";
import { readFile } from "node:fs/promises";
import { signedRequest } from "../util/sign.js";
import type { GoldItem } from "../verifier/known.js";
import { cardProblems, MODEL_CARD_KIND, signCard, type ModelCard } from "./card.js";
import type { ModelPassport } from "./passport.js";
import { scanModelFiles, scanModelFilesOnDisk, type DiskModelFile, type ModelFile } from "./safetensors.js";

// Publishing a model, from the creator's side: the malware checks run here first (so a bad file
// never leaves the machine), the weights go to Swarm as public content-addressed files, the card
// names each file's sha256 and Swarm reference, the creator signs it, and the verifier is paid
// its listing fee over x402 to review it with the other verifiers. The review runs in the
// background (minutes, on real networks); this waits for it to list the model or refuse it.

/** What a creator writes; the rest of the card (kind, creator, weights, date) is filled in. */
export type CardDraft = Omit<ModelCard, "kind" | "creator" | "createdAt" | "weights"> & {
  /** Where royalties go; default the creator's own account. */
  payTo?: string;
  /** For weights hosted elsewhere instead of uploaded: a base URL that serves each file by name. */
  weightsSource?: string;
};

/** Where to put the weights: 0G Storage (built for large files; pays 0G's storage fee) or Swarm. */
export type WeightsStore = "0g" | "swarm";

export interface PublishInput {
  card: CardDraft;
  /**
   * The model's files (safetensors weights, JSON configs, tokenizer files), all in memory or all on
   * disk (`{ name, path }`: large weights are hashed, checked and uploaded without being read
   * into memory). Omit for a 0G-served model.
   */
  files?: ModelFile[] | DiskModelFile[];
  /** Labelled examples, needed only when the verifiers have none for the card's task. */
  benchmark?: GoldItem[];
  /** The most the creator pays for the listing (default 0.1 ℏ). */
  maxFeeTinybar?: bigint;
  /** How long to wait for the verifier quorum's review (default 20 minutes). */
  timeoutMs?: number;
  /** Where the weights go (default 0G Storage when this role has a 0G Storage client, else Swarm). */
  storage?: WeightsStore;
}

export interface PublishResult {
  key: string;
  id: string;
  version: string;
  passportRef: string;
  passportDigest: string;
  accuracy: number;
  signers: string[];
  passport: ModelPassport;
  feeTx?: string;
}

export async function publishModel(svc: Services, verifierUrl: string, input: PublishInput, log: (msg: string) => void = () => {}): Promise<PublishResult> {
  const { payTo, weightsSource, ...draft } = input.card;
  let weights: ModelCard["weights"];
  if (input.files?.length) {
    const onDisk = input.files.every((f) => "path" in f);
    if (!onDisk && !input.files.every((f) => "bytes" in f)) throw new Error("give the model's files all in memory or all as paths");
    const scan = onDisk ? await scanModelFilesOnDisk(input.files as DiskModelFile[]) : scanModelFiles(input.files as ModelFile[]);
    if (!scan.ok) throw new Error(`malware checks failed locally, nothing was uploaded: ${scan.problems.join("; ")}`);
    log(`malware checks passed locally: ${scan.files.length} files, ${scan.params.toLocaleString("en-US")} parameters`);
    const files = [];
    const store: WeightsStore = input.storage ?? (svc.zgStorage ? "0g" : "swarm");
    for (const f of input.files) {
      const scanned = scan.files.find((s) => s.name === f.name)!;
      const base = { name: f.name, sha256: scanned.sha256, bytes: scanned.bytes };
      const bytes = async () => ("bytes" in f ? f.bytes : new Uint8Array(await readFile(f.path)));
      if (weightsSource) files.push(base);
      else if (store === "0g") {
        if (!svc.zgStorage) throw new Error("0G Storage isn't configured for this role");
        const zg = svc.zgStorage();
        const { root, tx } = "path" in f ? await zg.uploadFile(f.path) : await zg.upload(f.bytes);
        files.push({ ...base, zgRoot: root });
        log(`uploaded ${f.name} to 0G Storage: root ${root}${tx ? ` (tx ${tx})` : " (already stored)"}`);
      } else {
        const swarmRef = await svc.swarm.upload(await bytes(), { encrypt: false });
        files.push({ ...base, swarmRef });
        log(`uploaded ${f.name} to Swarm: ${swarmRef}`);
      }
    }
    weights = { format: "safetensors", files, ...(weightsSource ? { source: weightsSource } : {}) };
  }
  const card: ModelCard = {
    kind: MODEL_CARD_KIND,
    ...draft,
    creator: { address: svc.address, payTo: payTo ?? svc.payTo },
    ...(weights ? { weights } : {}),
    createdAt: new Date().toISOString(),
  };
  const problems = cardProblems(card);
  if (problems.length > 0) throw new Error(`the card isn't valid: ${problems.join("; ")}`);
  const signature = await signCard(svc.account, card);
  const paid = await payFetch(`${base(verifierUrl)}/models`, await signedRequest(svc.account, { card, signature, ...(input.benchmark ? { benchmark: input.benchmark } : {}) }), svc.payer(), input.maxFeeTinybar ?? 10_000_000n);
  if (!paid.response.ok) {
    const body = (await paid.response.json().catch(() => ({}))) as { error?: string; reasons?: string[] };
    throw new Error(`the verifier refused ${card.id}@${card.version} (${paid.response.status}): ${body.reasons?.join("; ") ?? body.error ?? "no reason given"}`);
  }
  const { key } = (await paid.response.json()) as { key: string };
  const feeTx = paid.settlement?.transaction;
  log(`the verifier quorum is reviewing ${card.id}@${card.version} (${key})${feeTx ? `; listing fee ${feeTx}` : ""}`);
  const review = await waitForReview(verifierUrl, key, input.timeoutMs ?? 20 * 60_000);
  if (review.status !== "listed" || !review.listing) throw new Error(`the verifiers refused ${card.id}@${card.version}: ${review.reasons?.join("; ") ?? "no reason given"}`);
  const passport = (await (await fetch(`${base(verifierUrl)}/models/${key}/passport`)).json()) as ModelPassport;
  return { key, id: card.id, version: card.version, ...review.listing, passport, ...(feeTx ? { feeTx } : {}) };
}

export interface ReviewState {
  status: "reviewing" | "listed" | "refused";
  reasons?: string[];
  listing?: { passportRef: string; passportDigest: string; accuracy: number; signers: string[] };
}

const base = (url: string) => url.replace(/\/$/, "");

/** Polls a model's review until the verifiers list it or refuse it. */
export async function waitForReview(verifierUrl: string, key: string, timeoutMs: number, everyMs = 2000): Promise<ReviewState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${base(verifierUrl)}/models/reviews/${key}`).catch(() => undefined);
    if (res?.ok) {
      const review = (await res.json()) as ReviewState;
      if (review.status !== "reviewing") return review;
    }
    if (Date.now() >= deadline) throw new Error(`the review of ${key} didn't finish in ${Math.round(timeoutMs / 60_000)} minutes; check GET /models/reviews/${key}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
