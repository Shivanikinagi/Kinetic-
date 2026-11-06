import { recoverMessageAddress, type Hex, type LocalAccount } from "viem";
import type { Check } from "../agent/passport.js";
import { canonicalJson, sha256Hex } from "../util/crypto.js";
import { cardDigest, cardProblems, cardSigner, modelKey, type ModelCard } from "./card.js";
import type { ScanCheck, ScannedFile } from "./safetensors.js";

// The Model Passport: signed evidence about one model version, issued before it can be listed.
// It records what was checked and the result, never a blanket "safe":
//   - the creator's signed card (id, version, task, runtime, weights hashes, licence, royalty);
//   - the malware checks on the weights (safetensors only, no code, headers that exactly fill
//     each file), with each file's sha256 and the parameter count read from the headers;
//   - a benchmark on labelled examples the creator never saw, run by the verifiers themselves;
//   - a behavioural fingerprint: the model's answers on borderline inputs, which later tell
//     whether a provider really runs this model;
//   - signatures from a quorum of the bond vault's verifiers, each of which re-ran the checks.
// It goes on Swarm (public), its digest on HCS, and the listing that points to it on Arkiv.

export const MODEL_PASSPORT_KIND = "kinetic.model-passport.v1";

export type WeightsCheck =
  | { checked: true; ok: boolean; params: number; dtypes: string[]; files: ScannedFile[]; checks: ScanCheck[] }
  | { checked: false; reason: string };

export interface ModelBenchmark {
  /** sha256 of the task spec it was scored on (the card's task). */
  task: string;
  /** "verifier": the verifiers' own labelled set, unseen by the creator. "creator": examples the creator supplied. */
  source: "verifier" | "creator";
  items: number;
  /** sha256 of the canonical JSON of the item ids (verifier set) or the items themselves (creator set). */
  itemsHash: string;
  correct: number;
  accuracy: number;
  /** The bar it had to clear to be listed. */
  minAccuracy: number;
  /** Where the lead verifier ran it. */
  ranOn: string[];
}

export interface ModelFingerprint {
  /** sha256 of the task the probe items belong to. */
  task: string;
  /** The model's answer to each probe item, by id. */
  answers: Record<string, string>;
}

export interface ModelPassportBody {
  kind: typeof MODEL_PASSPORT_KIND;
  key: string;
  network: string;
  issuedAt: string;
  card: ModelCard;
  cardDigest: string;
  creatorSignature: string;
  weights: WeightsCheck;
  benchmark: ModelBenchmark;
  fingerprint?: ModelFingerprint;
  references: { hcsTopic: string; swarmGateway: string; vault?: string };
  /** What this passport does not prove. */
  limitations: string[];
}

export interface ModelPassport extends ModelPassportBody {
  attestations: { verifiers: { address: string; signature: string }[] };
}

export function modelPassportBody(p: ModelPassport | ModelPassportBody): ModelPassportBody {
  const { attestations: _, ...body } = p as ModelPassport;
  return body;
}

export const modelPassportDigest = (p: ModelPassport | ModelPassportBody) => sha256Hex(canonicalJson(modelPassportBody(p)));

const message = (p: ModelPassportBody) => `${MODEL_PASSPORT_KIND}:${modelPassportDigest(p)}`;

export async function signModelPassport(account: LocalAccount, body: ModelPassportBody): Promise<{ address: string; signature: string }> {
  return { address: account.address.toLowerCase(), signature: await account.signMessage({ message: message(body) }) };
}

export async function modelPassportSigner(body: ModelPassportBody, signature: string): Promise<string | null> {
  try {
    return (await recoverMessageAddress({ message: message(body), signature: signature as Hex })).toLowerCase();
  } catch {
    return null;
  }
}

/** The verifiers (from `allowed`) whose signatures on the passport are valid. */
export async function modelPassportSigners(p: ModelPassport, allowed: string[]): Promise<string[]> {
  const body = modelPassportBody(p);
  const ok = new Set<string>();
  for (const a of p.attestations?.verifiers ?? []) {
    const signer = await modelPassportSigner(body, a.signature);
    if (signer && signer === a.address.toLowerCase() && allowed.includes(signer)) ok.add(signer);
  }
  return [...ok];
}

/** What every listing's passport must say, whatever verifiers signed it. */
export function modelPassportLimitations(card: ModelCard, weights: WeightsCheck, benchmark: ModelBenchmark, fingerprint?: ModelFingerprint): string[] {
  return [
    `The benchmark scored ${benchmark.correct} of ${benchmark.items} labelled examples (${Math.round(benchmark.accuracy * 100)}%). It measures accuracy on this task, not safety.`,
    weights.checked
      ? "The malware checks rule out executable code in the files and anything hidden around the tensors. They can't detect a backdoor trained into the weights."
      : `${weights.reason} The file checks don't apply; the passport rests on the benchmark and fingerprint.`,
    fingerprint
      ? "The fingerprint is statistical evidence of which model a provider runs, not proof: it is recorded on every admission and never slashes on its own."
      : "No fingerprint: there are no probe items for this task, so providers' model identity rests on the model they sign for.",
    `Royalty terms (${card.royaltyBps / 100}%) are fixed for version ${card.version}; a new royalty needs a new version.`,
  ];
}

/** Checks a Model Passport offline: card, creator signature, weights, benchmark and the verifier quorum. */
export async function verifyModelPassport(p: ModelPassport, opts: { verifiers: string[]; threshold: number }): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean | null, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });
  add("format", p?.kind === MODEL_PASSPORT_KIND, p?.kind);
  if (p?.kind !== MODEL_PASSPORT_KIND) return checks;
  const problems = cardProblems(p.card);
  add("the card is complete and valid", problems.length === 0, problems.slice(0, 2).join("; ") || undefined);
  add("the key names this id and version", p.key === modelKey(p.card.id, p.card.version), p.key);
  add("the card digest matches the card", p.cardDigest === cardDigest(p.card));
  add("signed by the creator", (await cardSigner(p.card, p.creatorSignature)) === p.card.creator.address, p.card.creator.address);
  if (p.weights.checked) {
    const listed = new Map((p.card.weights?.files ?? []).map((f) => [f.name, f.sha256]));
    const same = p.weights.files.every((f) => listed.get(f.name) === f.sha256);
    add("malware checks passed", p.weights.ok && p.weights.checks.every((c) => c.ok), p.weights.checks.filter((c) => !c.ok).map((c) => c.name).join("; ") || `${p.weights.files.length} files, ${p.weights.params.toLocaleString("en-US")} parameters`);
    add("scanned files are the card's files", same && p.weights.files.length === listed.size);
  } else {
    add("malware checks", null, p.weights.reason);
  }
  const b = p.benchmark;
  add("benchmark clears the listing bar", b.items > 0 && b.correct <= b.items && Math.abs(b.accuracy - b.correct / b.items) < 1e-9 && b.accuracy >= b.minAccuracy, `${b.correct}/${b.items} (${Math.round(b.accuracy * 100)}%), bar ${Math.round(b.minAccuracy * 100)}%`);
  const signers = await modelPassportSigners(p, opts.verifiers.map((v) => v.toLowerCase()));
  add("signed by a quorum of the vault's verifiers", signers.length >= opts.threshold, `${signers.length} signed, ${opts.threshold} needed`);
  return checks;
}
