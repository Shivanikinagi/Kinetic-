import { createPublicClient, http, parseAbi, recoverMessageAddress, type Hex, type LocalAccount } from "viem";
import { hederaTestnet } from "viem/chains";
import { agreementHash, type Agreement } from "../core/agreement.js";
import { verifyReveal } from "../core/canary.js";
import { verifyKnownReveal } from "../verifier/known.js";
import { authenticityOf, correctnessOf, summarize, type Authenticity, type Correctness, type PassportSummary } from "./assurance.js";
import { passportSchema } from "./passport-schema.js";
import { readJobReceipts } from "../integrations/hcs.js";
import { creditedAmount } from "../integrations/mirror.js";
import { isStorageRef, storageUrl } from "../integrations/storage-ref.js";
import { VAULT_ABI } from "../integrations/vault.js";
import { formatHbar, type AttestationStatus, type ItemOutput, type PaymentAsset, type ProviderRank, type TaskSpec, type ZeroGExecution } from "../types.js";
import { canonicalJson, sha256Hex } from "../util/crypto.js";
import { modelPassportDigest, type ModelPassport } from "../models/passport.js";
import { executionHash, recoverResultSigner } from "../util/sign.js";
import type { ProviderReport } from "./buyer.js";
import { checkCanarySigner, recheckCanaryTee, type CanaryTee } from "../integrations/zerog-tee.js";
import { zeroGDirectory } from "../integrations/zerog-compute.js";
import { chunkLeaf, chunkLeaves, leafHash, merkleProof, merkleRoot, verifyMerkleProof, type ProofStep } from "../core/merkle.js";
import { spotCandidates, spotPicks, spotTag } from "../core/spot.js";

// The Compute Passport: one public, signed record of how a job's results were produced and
// checked. It replaces the plain audit bundle and keeps its fields; it's stored on 0G Storage. It holds no input
// data and no keys: only hashes, signatures, payments, check results and their limits.
//
// The buyer signs it, and the verifier co-signs only after comparing it with its own records.
// Anyone can check it with `npm run passport:verify`: signatures and hashes offline, then the
// HCS receipts, the payments on the mirror node and the slashes in the vault.

/** v2 adds per-chunk authenticity and correctness, commitments and a derived summary (docs/compute-passport.schema.json). */
export const PASSPORT_KIND = "kinetic.passport.v2";
/** Passports this code can still check. */
export const PASSPORT_KINDS = ["kinetic.passport.v1", PASSPORT_KIND] as const;
export type PassportKind = (typeof PASSPORT_KINDS)[number];

/** One finished chunk: who produced it, the result hash they signed, and what was paid. */
export interface PassportWork {
  idx: number;
  /** Items in this chunk's result, so a results file can be split back into chunks. */
  items: number;
  provider: string;
  resultHash: string;
  /** The provider's EIP-191 signature over {jobId, idx, resultHash}. */
  signature: string;
  payTx?: string;
  /** In the payment asset's smallest unit. */
  amount: string;
  /** "verified": a canary that agreed with 0G. "format": passed the format check only. */
  check: "verified" | "format";
  /** Which 0G Compute provider ran the chunk, when the provider called one directly. Covered by `signature`. */
  execution?: ZeroGExecution;
  /** The verifier's own attestation check of that execution: verified, unavailable or invalid. */
  attestation?: AttestationStatus;
  /** Why it is not verified, when it isn't. */
  attestationReason?: string;
  /**
   * The verifier's planted known-answer items in this chunk's signed result, with their
   * positions: they are left out of the job's results, and put back to recompute resultHash.
   */
  planted?: { at: number; item: ItemOutput }[];
  /** How the chunk scored on those known answers. */
  known?: { items: number; correct: number };
  /** The 0G service's on-chain verifiability (TeeML, SPML, …), as the verifier read it from the registry. */
  verifiability?: string;
  /**
   * HMAC-SHA256 of the chunk's own input items under a key derived from the job key, which only
   * the buyer holds: it hides the data, and the buyer can open it later to prove what was sent.
   */
  inputCommitment?: string;
  /** High assurance: the other independent provider whose copy agreed with this one, and how closely. */
  redundancy?: { with: string; agreement: number };
  /** v2: where and how it ran, and what was attested. Separate from whether the answer was right. */
  authenticity?: Authenticity;
  /** v2: how the answer was checked, and the strongest check it passed. */
  correctness?: Correctness;
  /**
   * The proof that this chunk's record (core/merkle.ts `chunkLeaf`) is under the job's HCS Merkle
   * anchor: sibling hashes from the leaf up, in the format of Hedera's batch-anchor tutorial.
   */
  merkleProof?: ProofStep[];
}

/**
 * The job's one `hcs.merkleRootAnchor` message: a SHA-256 Merkle root over every finished
 * chunk's record ({job, idx, provider, resultHash, payTx} as canonical JSON, in chunk order).
 */
export interface PassportAnchor {
  schema: "hcs.merkleRootAnchor";
  hashAlg: "sha256";
  leaf: "kinetic.chunk.v1";
  merkleRoot: string;
  recordCount: number;
  /** Its sequence number on the job's HCS topic. */
  hcsSequence: number;
  tx?: string;
}

/**
 * Spot checks after the job closed (core/spot.ts): a Hedera PRNG seed the verifier drew in the
 * bond vault after the canary reveal picks finished, non-canary chunks to re-run on 0G.
 */
export interface PassportSpot {
  /** The vault tag the seed was drawn under: keccak256("kinetic.spot.v1:" + jobId). */
  tag: string;
  seed: string;
  /** The draw's consensus time, unix seconds, as the vault recorded it. */
  drawnAt: number;
  seedTx?: string;
  picks: number[];
  /** No agreement: 0G gave no reference, so the pick was not scored. */
  checked: { idx: number; provider: string; agreement?: number; pass?: boolean; zeroGRequest?: string; model?: string }[];
  hcsSequence: number;
}

/** Where the verifier planted known answers, committed on HCS before work and revealed after. */
export interface PassportKnown {
  commitment: string;
  placements: { idx: number; ids: string[] }[];
  salt: string;
  checked: { idx: number; provider: string; items: number; correct: number; pass: boolean }[];
}

export interface PassportCanary {
  idx: number;
  provider: string;
  agreement: number;
  pass: boolean;
  zeroGRequest: string;
  model: string;
  /** The reference run's TEE evidence: trust mode, 0G provider, chat id, signed text and signature, signer, our result, cost. */
  tee?: CanaryTee;
}

export interface PassportProvider {
  name: string;
  address: string;
  payTo?: string;
  uaid?: string;
  gpu?: string;
  /** What the provider says it runs. Not proven. */
  declaredModel?: string;
  /** Set for an adversarial test provider: how it said it would cheat. */
  adversarial?: string;
  status: ProviderReport["status"];
  rank?: ProviderRank;
  /** Admission result, and whether it answered like its declared model (evidence, not proof). */
  admission?: { admitted: boolean; agreement: number; latencyMs: number; skipped?: boolean; reason?: string; fingerprint?: { declared: string; verdict: "consistent" | "mismatch" | "inconclusive"; match: number; closest?: string } };
  /** Quoted price per chunk, in the payment asset's smallest unit. */
  price: string;
  served: number;
  kept: number;
  paid: string;
  /** HBAR (tinybar): refunds come out of the bond. */
  refund: string;
  undelivered: string;
  vaultTx?: string;
  /** The vault's slash id and outcome, and the verifiers whose signatures carried it. */
  slashId?: string;
  slashStatus?: ProviderReport["slashStatus"];
  slashSigners?: string[];
  burned?: string;
}

/** A model job: the listed model, its passport and the creator's royalty, paid over x402. Tinybar. */
export interface PassportModel {
  key: string;
  id: string;
  version: string;
  passportRef: string;
  passportDigest: string;
  royaltyBps: number;
  /** Where the royalty was paid: the creator's account. */
  payTo: string;
  royalty?: { amount: string; basis: string; tx: string };
}

export interface PassportBody {
  kind: PassportKind;
  jobId: string;
  issuedAt: string;
  network: string;
  buyer: { address: string; uaid?: string };
  task: { kind: TaskSpec["kind"]; labels?: string[]; fields?: string[] };
  items: number;
  chunkSize: number;
  chunks: number;
  completed: number;
  /** sha256 of the canonical JSON of the job's results, in chunk order. */
  output: { resultsHash: string };
  hcsTopic: string;
  /**
   * storageGateway: the 0G Storage indexer passports are served from. Passports issued before
   * 2026-11-11 name a `swarmGateway` instead; it stays readable so their signatures still check.
   */
  references: { x402Network: string; hcsTopic: string; mirrorUrl: string; vault?: string; storageGateway?: string; swarmGateway?: string; devnetUrl?: string };
  strategy?: string;
  /** The rules agreed before any chunk ran; their hash is in the HCS `job` receipt. */
  agreement: Agreement;
  /** Whether the agreement was met, and why not. */
  outcome: Outcome;
  canaries: { commitment: string; revealed: number[]; salt: string; checked: PassportCanary[]; known?: PassportKnown };
  /** `known`: chunks whose planted known answers were all right (ground truth). `verified`: chunks that also agreed with a 0G reference run. */
  coverage: { verified: number; formatOnly: number; share: number; known?: number };
  policy: { canaryRate: number; minAgreement: number; window: number; failLimit: number };
  payment: PaymentAsset;
  verificationFee: { tinybar: string; tx?: string };
  providers: PassportProvider[];
  work: PassportWork[];
  /** v2: the headline, derived from the chunks and checks above; anyone can recompute it. */
  summary?: PassportSummary;
  /** What this passport does not prove. */
  limitations: string[];
  /** The listed model the job ran, when it named one. */
  model?: PassportModel;
  /** The HCS Merkle anchor over the finished chunks; each chunk carries its proof. */
  anchor?: PassportAnchor;
  /** Chunks re-checked after the job, picked by a Hedera PRNG seed. */
  spot?: PassportSpot;
}

export interface Attestation {
  address: string;
  signature: string;
  uaid?: string;
}

export interface Outcome {
  met: boolean;
  notes: string[];
}

export interface Passport extends PassportBody {
  attestations: { buyer?: Attestation; verifier?: Attestation };
}

export interface PassportInput {
  jobId: string;
  network: string;
  buyer: { address: string; uaid?: string };
  task: TaskSpec;
  items: number;
  chunkSize: number;
  chunks: number;
  results: ItemOutput[];
  work: PassportWork[];
  canaries: PassportBody["canaries"];
  /** Canaries the verifier accepted unscored because 0G returned no reference. */
  unscoredCanaries: number;
  policy: PassportBody["policy"];
  payment: PaymentAsset;
  verificationFee: PassportBody["verificationFee"];
  providers: ProviderReport[];
  references: PassportBody["references"];
  strategy?: string;
  agreement: Agreement;
  outcome: Outcome;
  model?: PassportModel;
  /** From the verifier's finalize: its HCS Merkle anchor and PRNG spot checks. */
  anchor?: PassportAnchor;
  spot?: PassportSpot;
}

export function resultsHash(results: ItemOutput[]): string {
  return sha256Hex(canonicalJson(results));
}

/** What the canaries' TEE signatures do and don't establish, and any canary that left the TeeML tier. */
function canaryTeeLimitations(checked: PassportCanary[]): string[] {
  const tees = checked.map((c) => c.tee).filter((t): t is CanaryTee => !!t);
  if (tees.length === 0) return [];
  const verified = tees.filter((t) => t.verification === "verified").length;
  const fellBack = tees.filter((t) => t.fallback).length;
  const sealed = tees.some((t) => t.scheme?.startsWith("zg-sig-v1/e2ee-ct"));
  return [
    `0G reference runs: ${verified} of ${tees.length} canary TEE signatures verified by the verifier against the signer in 0G's serving contract.` +
      (sealed ? " The router seals each request to the enclave, so the signature covers the encrypted exchange; 0G's attested E2EE gateway, not KINETIC, holds the ciphertext it binds." : ""),
    ...(fellBack ? [`${fellBack} canary reference run${fellBack === 1 ? "" : "s"} had no TeeML provider in private mode and ran in verified mode (TeeTLS relays admitted).`] : []),
  ];
}

export function buildPassportBody(input: PassportInput): PassportBody {
  const declared = new Map(input.providers.map((p) => [p.provider.toLowerCase(), p.backend]));
  const sorted = [...input.work].sort((a, b) => a.idx - b.idx);
  // Each chunk's proof under the anchored root, from the same records the verifier anchored.
  const leaves = input.anchor ? chunkLeaves(input.jobId, sorted) : [];
  const work = sorted.map((w, i) => ({
    ...w,
    authenticity: authenticityOf(w, declared.get(w.provider.toLowerCase()), w.verifiability),
    correctness: correctnessOf(w),
    ...(input.anchor ? { merkleProof: merkleProof(leaves, i) } : {}),
  }));
  const verified = work.filter((w) => w.check === "verified").length;
  const formatOnly = work.length - verified;
  const known = work.filter((w) => w.known && w.known.correct === w.known.items).length;
  const limitations = [
    `Checks are sampled: ${verified} of ${input.chunks} chunks were compared with a 0G verified run; ${formatOnly} passed a format check only.`,
    ...(input.canaries.known
      ? [`Ground truth: ${known} of ${work.length} chunks answered the verifier's planted known-answer items correctly; that is what slashing rests on. A known answer checks one item per chunk, not every item.`]
      : ["No known answers were planted: the verifier has no labelled examples for this task, so nothing was checked against ground truth."]),
    "Agreement with 0G measures consistency with a reference model, not ground truth.",
    input.model
      ? `Every chunk is signed for ${input.model.id}@${input.model.version} (Model Passport ${input.model.passportDigest.slice(0, 12)}…); providers' admission fingerprints are evidence of which model ran, not proof.`
      : "Each provider's model is what it declared; nothing here proves which model ran.",
    "One verifier ran the checks. It committed to the canary set on HCS before any chunk ran and revealed it at the end.",
    ...(input.unscoredCanaries > 0 ? [`${input.unscoredCanaries} canary check${input.unscoredCanaries === 1 ? "" : "s"} could not be scored because 0G returned no reference.`] : []),
    ...canaryTeeLimitations(input.canaries.checked),
    ...(input.spot ? [spotLimitation(input.spot)] : []),
    ...(work.length < input.chunks ? [`Incomplete: ${work.length} of ${input.chunks} chunks have results.`] : []),
  ];
  return {
    kind: PASSPORT_KIND,
    jobId: input.jobId,
    issuedAt: new Date().toISOString(),
    network: input.network,
    buyer: { address: input.buyer.address, ...(input.buyer.uaid ? { uaid: input.buyer.uaid } : {}) },
    task: { kind: input.task.kind, labels: input.task.labels?.map((l) => l.name), fields: input.task.fields?.map((f) => f.name) },
    items: input.items,
    chunkSize: input.chunkSize,
    chunks: input.chunks,
    completed: work.length,
    output: { resultsHash: resultsHash(input.results) },
    hcsTopic: input.references.hcsTopic,
    references: input.references,
    ...(input.strategy ? { strategy: input.strategy } : {}),
    agreement: input.agreement,
    outcome: input.outcome,
    canaries: input.canaries,
    coverage: { verified, formatOnly, share: input.chunks ? Math.round((verified / input.chunks) * 1000) / 1000 : 0, ...(input.canaries.known ? { known } : {}) },
    policy: input.policy,
    payment: input.payment,
    verificationFee: input.verificationFee,
    providers: input.providers.map((p) => ({
      name: p.name,
      address: p.provider,
      payTo: p.payTo,
      uaid: p.uaid,
      gpu: p.gpu,
      declaredModel: p.backend,
      ...(p.adversarial ? { adversarial: p.adversarial } : {}),
      status: p.status,
      rank: p.rank,
      admission: p.qualification,
      price: p.priceTinybar.toString(),
      served: p.served,
      kept: p.kept,
      paid: p.paidTinybar.toString(),
      refund: p.refundTinybar.toString(),
      undelivered: p.undeliveredTinybar.toString(),
      vaultTx: p.vaultTx,
      ...(p.slashId ? { slashId: p.slashId, slashStatus: p.slashStatus, slashSigners: p.slashSigners, ...(p.burnedTinybar !== undefined ? { burned: p.burnedTinybar.toString() } : {}) } : {}),
    })),
    work,
    summary: summarize({ chunks: input.chunks, work, known: input.canaries.known, checked: input.canaries.checked, providers: input.providers, agreement: input.agreement, revealed: input.canaries.revealed }),
    limitations,
    ...(input.model ? { model: input.model } : {}),
    ...(input.anchor ? { anchor: input.anchor } : {}),
    ...(input.spot ? { spot: input.spot } : {}),
  };
}

/** What the PRNG spot checks found, and what they don't change. */
function spotLimitation(s: PassportSpot): string {
  const scored = s.checked.filter((c) => c.pass !== undefined);
  const passed = scored.filter((c) => c.pass).length;
  if (s.picks.length === 0) return "PRNG spot checks: every finished chunk was already a canary, so the seed picked none.";
  return (
    `PRNG spot checks: ${s.picks.length} chunk${s.picks.length === 1 ? "" : "s"} picked after the job by a Hedera PRNG seed and re-run on 0G; ` +
    `${passed} of ${scored.length} scored agreed${scored.length < s.picks.length ? `, ${s.picks.length - scored.length} could not be scored` : ""}. ` +
    "They are evidence only: they don't change a chunk's check, and don't count toward slashing."
  );
}

/** The passport without its signatures: what both parties sign. */
export function passportBody(p: Passport | PassportBody): PassportBody {
  const { attestations: _, ...body } = p as Passport;
  return body;
}

export function passportDigest(body: PassportBody): string {
  return sha256Hex(canonicalJson(passportBody(body)));
}

const message = (body: PassportBody) => `${body.kind}:${passportDigest(body)}`;

export async function signPassport(account: LocalAccount, body: PassportBody): Promise<Attestation> {
  return { address: account.address.toLowerCase(), signature: await account.signMessage({ message: message(body) }) };
}

/** Who signed a passport body, or null for a signature that doesn't recover. */
export async function signerOf(body: PassportBody, signature: string): Promise<string | null> {
  try {
    return (await recoverMessageAddress({ message: message(body), signature: signature as Hex })).toLowerCase();
  } catch {
    return null;
  }
}

// ── Verification ─────────────────────────────────────────────────────────────

export interface Check {
  name: string;
  /** null when the check was skipped. */
  ok: boolean | null;
  detail?: string;
}

export interface VerifyOptions {
  /** The job's results (e.g. `results` from out/<jobId>.json), to check against the signed hashes. */
  results?: ItemOutput[];
  /** Also check HCS, the mirror node and the vault. */
  online?: boolean;
  mirrorUrl?: string;
  jsonRpcUrl?: string;
  /** The 0G chain the router's providers are registered on, for the canary TEE signers (default 0G mainnet). */
  zgTeeRpcUrl?: string;
}

const lower = (s?: string) => (s ?? "").toLowerCase();

export async function verifyPassport(p: Passport, opts: VerifyOptions = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean | null, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });
  const body = passportBody(p);

  add("format", (PASSPORT_KINDS as readonly string[]).includes(p.kind), p.kind);
  if (p.kind === PASSPORT_KIND) {
    const shape = passportSchema.safeParse(p);
    add("matches the Compute Passport v2 schema", shape.success, shape.success ? undefined : shape.error.issues.slice(0, 2).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    // Each chunk's claims follow from its evidence, and the summary from the chunks.
    const declared = new Map(p.providers.map((x) => [lower(x.address), x.declaredModel]));
    const authOff = p.work.filter((w) => canonicalJson(w.authenticity) !== canonicalJson(authenticityOf(w, declared.get(lower(w.provider)), w.verifiability))).map((w) => w.idx);
    add("authenticity claims follow from the execution records", authOff.length === 0, authOff.length ? `chunks ${authOff.join(",")}` : undefined);
    const correctOff = p.work.filter((w) => canonicalJson(w.correctness) !== canonicalJson(correctnessOf(w))).map((w) => w.idx);
    add("correctness levels follow from the checks", correctOff.length === 0, correctOff.length ? `chunks ${correctOff.join(",")}` : undefined);
    add("summary matches the evidence", canonicalJson(p.summary) === canonicalJson(summarize({ chunks: p.chunks, work: p.work, known: p.canaries.known, checked: p.canaries.checked, providers: p.providers, agreement: p.agreement, revealed: p.canaries.revealed })));
  }

  // Signatures: the buyer issued it, the verifier co-signed the same bytes.
  const buyer = p.attestations?.buyer;
  const buyerSigner = buyer ? await signerOf(body, buyer.signature) : null;
  add("signed by the buyer", buyerSigner !== null && buyerSigner === lower(p.buyer.address), buyer ? undefined : "no buyer signature");
  const verifier = p.attestations?.verifier;
  const verifierSigner = verifier ? await signerOf(body, verifier.signature) : null;
  add("co-signed by the verifier", verifier ? verifierSigner === lower(verifier.address) : false, verifier ? verifier.address : "the verifier did not co-sign");

  // Canaries: the reveal must match the commitment made before any chunk ran.
  const { commitment, revealed, salt, checked } = p.canaries;
  add("canary reveal matches the commitment", verifyReveal(p.jobId, revealed, salt, commitment));
  const revealedSet = new Set(revealed);
  add("every scored canary was in the committed set", checked.every((c) => revealedSet.has(c.idx)));
  await checkCanaryTees(checked, add);
  // Known answers: the placements match their commitment, and every chunk counted as right on
  // ground truth has a passing known-answer check by the provider that produced it.
  const k = p.canaries.known;
  if (k) {
    add("known-answer placements match the commitment", verifyKnownReveal(p.jobId, k.placements, k.salt, k.commitment));
    const passedKnown = new Set(k.checked.filter((c) => c.pass).map((c) => `${c.idx}|${lower(c.provider)}`));
    const plantedAt = new Map(k.placements.map((x) => [x.idx, new Set(x.ids)]));
    const wrong = p.work.filter((w) => {
      const ids = plantedAt.get(w.idx);
      const plantedIds = (w.planted ?? []).map((x) => x.item.id);
      return (w.known && !passedKnown.has(`${w.idx}|${lower(w.provider)}`)) || plantedIds.some((id) => !ids?.has(id)) || (ids && plantedIds.length !== ids.size);
    });
    add("every chunk's known answers were planted where committed, and passed", wrong.length === 0, wrong.length ? `chunks ${wrong.map((w) => w.idx).join(",")}` : `${passedKnown.size} chunks`);
  }

  // Work: every chunk's result hash was signed by the provider that produced it.
  let badSig: number | undefined;
  for (const w of p.work) {
    const signer = await recoverResultSigner(p.jobId, w.idx, w.resultHash, w.signature as Hex, executionHash(w.execution), p.model?.key).catch(() => "");
    if (signer !== lower(w.provider)) {
      badSig = w.idx;
      break;
    }
  }
  add("each chunk's result is signed by its provider", badSig === undefined, badSig === undefined ? `${p.work.length} chunks` : `chunk ${badSig}`);
  // Where chunks ran: the 0G Compute provider named in each signed execution record.
  const onZeroG = p.work.filter((w) => w.execution);
  if (onZeroG.length > 0) {
    const upstreams = new Set(onZeroG.map((w) => w.execution!.zgProvider));
    const count = (a: AttestationStatus) => onZeroG.filter((w) => (w.attestation ?? "unavailable") === a).length;
    const relayed = onZeroG.filter((w) => w.execution!.providerType === "centralized").length;
    add(
      "no accepted chunk has an invalid 0G attestation",
      count("invalid") === 0,
      `${onZeroG.length} of ${p.work.length} chunks on ${upstreams.size} 0G Compute provider${upstreams.size === 1 ? "" : "s"}: ${count("verified")} verified, ${count("unavailable")} unavailable, ${count("invalid")} invalid`,
    );
    // Reported, never passed off as verified: no attestation, or a TEE relay to an outside cloud.
    add("every 0G chunk is TEE-verified", count("verified") === onZeroG.length ? true : null, count("verified") === onZeroG.length ? undefined : `${count("unavailable")} chunk(s) had no attestation to check`);
    if (relayed > 0) add("every 0G chunk ran on a 0G node (not a relay to an outside cloud)", null, `${relayed} chunk(s) relayed by a centralized 0G provider`);
  }
  const passed = new Set(checked.filter((c) => c.pass).map((c) => `${c.idx}|${lower(c.provider)}`));
  const unbacked = p.work.filter((w) => w.check === "verified" && !passed.has(`${w.idx}|${lower(w.provider)}`)).map((w) => w.idx);
  add("each verified chunk has a passing canary", unbacked.length === 0, unbacked.length ? `chunks ${unbacked.join(",")}` : undefined);
  const verifiedCount = p.work.filter((w) => w.check === "verified").length;
  add("coverage numbers add up", verifiedCount === p.coverage.verified && p.work.length === p.completed && p.coverage.formatOnly === p.work.length - verifiedCount);

  // The agreement: the rules set before work, and whether the job kept to them.
  const a = p.agreement;
  if (a) {
    const planned = a.canaryRate > 0 ? Math.min(p.chunks, Math.max(1, Math.round(p.chunks * a.canaryRate))) : 0;
    add("checks meet the agreed rate", revealed.length >= planned, `${revealed.length} of ${p.chunks} chunks; agreed ${Math.round(a.canaryRate * 100)}%`);
    const scores = new Map(checked.filter((c) => c.pass).map((c) => [`${c.idx}|${lower(c.provider)}`, c.agreement]));
    const below = p.work.filter((w) => w.check === "verified" && (scores.get(`${w.idx}|${lower(w.provider)}`) ?? 0) < a.minAgreement).map((w) => w.idx);
    add("verified chunks meet the agreed pass mark", below.length === 0, below.length ? `chunks ${below.join(",")}` : `${Math.round(a.minAgreement * 100)}%`);
    add("outcome matches the work", p.outcome?.met === (p.completed === p.chunks), p.outcome?.met ? "agreement met" : "agreement not met");
    if (a.quote) {
      // Everything the buyer paid (every provider, failed attempts included) plus the fee and any royalty, against the firm quote.
      const paid = p.providers.reduce((sum, x) => sum + BigInt(x.paid), 0n) + BigInt(p.verificationFee.tinybar) + BigInt(p.model?.royalty?.amount ?? 0);
      const cap = BigInt(a.budget.maxSpend) < BigInt(a.quote.total) ? BigInt(a.budget.maxSpend) : BigInt(a.quote.total);
      add("spending stayed within the firm quote", paid <= cap, `${formatHbar(paid)} of ${formatHbar(cap)}`);
    }
  } else {
    add("agreement", null, "none recorded (older passport)");
  }

  // A model job: the terms agreed before work, and a royalty that is exactly the creator's share
  // of the payments for the chunks kept (none for refunded or rerouted ones).
  if (p.model) {
    const m = p.model;
    const t = p.agreement?.model;
    add("model terms match the agreement committed before work", !!t && t.key === m.key && t.passport === m.passportDigest && t.royaltyBps === m.royaltyBps && t.payTo === m.payTo, `${m.id}@${m.version}`);
    const basis = p.work.reduce((sum, w) => sum + BigInt(w.amount), 0n);
    const owed = (basis * BigInt(m.royaltyBps)) / 10_000n;
    add(
      "creator royalty is the agreed share of the accepted chunks",
      m.royalty ? BigInt(m.royalty.amount) === owed && BigInt(m.royalty.basis) === basis : owed === 0n,
      m.royalty ? `${formatHbar(BigInt(m.royalty.amount))} = ${m.royaltyBps / 100}% of ${formatHbar(basis)}` : owed === 0n ? "nothing owed" : `${formatHbar(owed)} owed, not paid`,
    );
  }

  // Results: the file you hold is exactly what the providers signed.
  if (opts.results) {
    add("results match the output hash", resultsHash(opts.results) === p.output.resultsHash);
    let offset = 0;
    let mismatch: number | undefined;
    for (const w of [...p.work].sort((a, b) => a.idx - b.idx)) {
      const items = opts.results.slice(offset, offset + w.items);
      offset += w.items;
      // Put the planted known-answer items back where they were in the signed result.
      for (const x of [...(w.planted ?? [])].sort((a, b) => a.at - b.at)) items.splice(x.at, 0, x.item);
      if (sha256Hex(canonicalJson({ items })) !== w.resultHash) {
        mismatch = w.idx;
        break;
      }
    }
    add("results match each chunk's signed hash", mismatch === undefined && offset === opts.results.length, mismatch === undefined ? undefined : `chunk ${mismatch}`);
  } else {
    add("results match the signed hashes", null, "pass --results <file> to check");
  }

  checkAnchorAndSpot(p, add);

  if (!opts.online) {
    add("public records (HCS, mirror node, vault)", null, "offline");
    return checks;
  }
  await verifyOnline(p, opts, add);
  await checkCanarySigners(p, opts, add);
  return checks;
}

/**
 * Offline: every canary's recorded TEE signature recovers to its recorded signer over the signed
 * text, its hash and scheme check out, a centralized provider's routing proof is bound to the
 * same exchange, and the recorded result ("verified" or not) follows from that.
 */
async function checkCanaryTees(checked: PassportCanary[], add: (name: string, ok: boolean | null, detail?: string) => void) {
  const withTee = checked.filter((c) => c.tee);
  if (withTee.length === 0) {
    if (checked.length > 0) add("canary TEE signatures re-verified", null, "no TEE evidence recorded (older passport)");
    return;
  }
  const bad: string[] = [];
  for (const c of withTee) {
    const r = await recheckCanaryTee(c.tee!);
    if (r && !r.ok) bad.push(`#${c.idx}: ${r.reason}`);
  }
  const verified = withTee.filter((c) => c.tee!.verification === "verified").length;
  add("canary TEE signatures re-verified", bad.length === 0, bad.length ? bad.slice(0, 3).join("; ") : `${verified} of ${checked.length} canaries signed by the 0G provider's TEE`);
  const fellBack = withTee.filter((c) => c.tee!.fallback || c.tee!.trustMode !== "private").length;
  const notVerified = withTee.length - verified;
  add(
    "every canary ran TeeML-only (private) with a verified TEE signature",
    fellBack === 0 && notVerified === 0 && withTee.length === checked.length ? true : null,
    fellBack || notVerified ? `${fellBack} outside private mode, ${notVerified} without a verified signature` : undefined,
  );
}

/** Online: each canary's signer is the TEE signer 0G's serving contract registers for its provider (0G mainnet). */
async function checkCanarySigners(p: Passport, opts: VerifyOptions, add: (name: string, ok: boolean | null, detail?: string) => void) {
  const tees = p.canaries.checked.map((c) => c.tee).filter((t): t is CanaryTee => !!t?.signer);
  if (tees.length === 0) return;
  const devnet = p.network === "devnet" && p.references.devnetUrl;
  const rpcUrl = opts.zgTeeRpcUrl ?? (devnet ? `${p.references.devnetUrl}/0gc` : "https://evmrpc.0g.ai");
  const directory = zeroGDirectory({ network: devnet ? "devnet" : "testnet", zgCompute: { rpcUrl } });
  const bad: string[] = [];
  try {
    for (const t of tees) {
      const r = await checkCanarySigner(directory, t);
      if (!r.ok) bad.push(`${t.provider.slice(0, 10)}: ${r.reason}`);
    }
  } catch (err) {
    add("0G: canary TEE signers registered on-chain", false, (err as Error).message);
    return;
  }
  add("0G: canary TEE signers registered on-chain", bad.length === 0, bad.length ? bad.slice(0, 3).join("; ") : `${new Set(tees.map((t) => t.provider)).size} provider(s)`);
}

/**
 * Offline: the Merkle root rebuilt from the chunks listed here is the anchored one, and each
 * chunk's proof leads to it; the spot checks' picks follow from their seed.
 */
function checkAnchorAndSpot(p: Passport, add: (name: string, ok: boolean | null, detail?: string) => void) {
  const a = p.anchor;
  if (a) {
    const leaves = chunkLeaves(p.jobId, p.work);
    add("Merkle root over the chunks matches the anchor", a.leaf === "kinetic.chunk.v1" && a.recordCount === leaves.length && merkleRoot(leaves) === a.merkleRoot, `${leaves.length} chunks, root ${a.merkleRoot.slice(0, 12)}…`);
    const unproven = p.work.filter((w) => !w.merkleProof || !verifyMerkleProof(leafHash(chunkLeaf(p.jobId, w)), a.merkleRoot, w.merkleProof)).map((w) => w.idx);
    add("each chunk's Merkle proof leads to the anchored root", unproven.length === 0, unproven.length ? `chunks ${unproven.slice(0, 5).join(",")}` : undefined);
  }
  const s = p.spot;
  if (s) {
    const candidates = spotCandidates(p.work.map((w) => w.idx), p.canaries.revealed);
    const expected = spotPicks(s.seed, p.jobId, candidates, s.picks.length);
    const listed = new Set(s.checked.map((c) => c.idx));
    add(
      "spot checks were picked by their PRNG seed",
      s.tag === spotTag(p.jobId) && JSON.stringify(expected) === JSON.stringify(s.picks) && s.picks.every((i) => listed.has(i)) && listed.size === s.picks.length,
      `${s.picks.length} of ${candidates.length} non-canary chunks`,
    );
    const failed = s.checked.filter((c) => c.pass === false).map((c) => c.idx);
    const unscored = s.checked.filter((c) => c.pass === undefined).length;
    // Evidence about the providers, not about this passport: shown, never counted as a failed check.
    add("PRNG spot checks agreed with 0G", failed.length === 0 && unscored === 0 ? true : null, failed.length ? `disagreed on chunks ${failed.join(",")}` : unscored ? `${unscored} not scored` : `${s.checked.length} checked`);
  }
}

/**
 * Online: the anchor is the job's `hcs.merkleRootAnchor` message on HCS; the spot checks match
 * their HCS receipt, their number was committed before work, and their seed is the vault's one
 * PRNG draw for the job, made after the canary reveal (so no result could depend on it).
 */
async function checkAnchorAndSpotOnline(p: Passport, opts: VerifyOptions, receipts: Awaited<ReturnType<typeof readJobReceipts>>, add: (name: string, ok: boolean | null, detail?: string) => void) {
  const find = (t: string) => receipts.find((m) => m.receipt.t === t);
  const a = p.anchor;
  if (a) {
    const m = find("anchor");
    const r = m?.receipt;
    add(
      "HCS: the chunks' Merkle root is anchored (hcs.merkleRootAnchor)",
      r?.t === "anchor" && r.schema === "hcs.merkleRootAnchor" && r.hashAlg === "sha256" && r.leaf === a.leaf && r.merkleRoot === a.merkleRoot && r.recordCount === a.recordCount && m!.sequence === a.hcsSequence,
      m ? `sequence ${m.sequence}` : "no anchor message for this job",
    );
  } else if (find("anchor")) add("HCS: the chunks' Merkle root is anchored (hcs.merkleRootAnchor)", false, "anchored on HCS but missing from the passport");
  const job = find("job")?.receipt;
  const committed = job?.t === "job" ? job.spot : undefined;
  const s = p.spot;
  if (!s) {
    if (committed) add("PRNG spot checks", null, `${committed} committed before work, none recorded`);
    return;
  }
  const m = find("spot");
  const r = m?.receipt;
  const recorded = s.checked.map((c) => ({ idx: c.idx, provider: c.provider, ...(c.agreement !== undefined ? { agreement: c.agreement, pass: c.pass, ref: c.zeroGRequest } : {}) }));
  add(
    "HCS: spot-check receipt matches",
    r?.t === "spot" && r.seed === s.seed && r.drawnAt === s.drawnAt && JSON.stringify(r.picks) === JSON.stringify(s.picks) && canonicalJson(r.checked) === canonicalJson(recorded) && m!.sequence === s.hcsSequence,
  );
  const candidates = spotCandidates(p.work.map((w) => w.idx), p.canaries.revealed).length;
  add("HCS: the number of spot checks was committed before work", committed !== undefined && s.picks.length === Math.min(committed, candidates), committed === undefined ? "not in the job receipt" : `${committed} committed`);
  const reveal = find("reveal");
  try {
    const drawn = await vaultReader(p, opts).seed(s.tag as Hex);
    add("vault: the spot-check seed is the job's one PRNG draw", !!drawn && drawn.seed.toLowerCase() === s.seed.toLowerCase() && drawn.drawnAt === s.drawnAt, drawn ? `drawn at ${new Date(drawn.drawnAt * 1000).toISOString()}` : "no seed drawn for this job");
    // After the reveal, when every result was signed and receipted. The draw's own consensus
    // time, from the mirror node, when it can be had; else the vault's record (to the block).
    const revealAt = reveal ? reveal.consensusTimestamp : undefined;
    let after = !!drawn && !!revealAt && drawn.drawnAt >= Math.floor(Number(revealAt)) - 2;
    let how = "vault time";
    if (revealAt && s.seedTx && p.network !== "devnet") {
      const res = await fetch(`${opts.mirrorUrl ?? p.references.mirrorUrl}/api/v1/contracts/results/${s.seedTx}`).catch(() => undefined);
      const at = res?.ok ? ((await res.json()) as { timestamp?: string }).timestamp : undefined;
      if (at) {
        after = compareTimestamps(at, revealAt) > 0;
        how = `seed tx at ${at}`;
      }
    }
    add("the spot-check seed was drawn after the canary reveal", after, revealAt ? `${how}, reveal at ${revealAt}` : "no reveal receipt");
  } catch (err) {
    add("vault: the spot-check seed is the job's one PRNG draw", false, (err as Error).message);
  }
}

/** Orders Hedera timestamps ("seconds.nanos"). */
function compareTimestamps(a: string, b: string): number {
  const parse = (t: string) => {
    const [s, n = "0"] = t.split(".");
    return BigInt(s!) * 1_000_000_000n + BigInt(n.padEnd(9, "0").slice(0, 9));
  };
  const d = parse(a) - parse(b);
  return d > 0n ? 1 : d < 0n ? -1 : 0;
}

async function verifyOnline(p: Passport, opts: VerifyOptions, add: (name: string, ok: boolean | null, detail?: string) => void) {
  const mirrorUrl = opts.mirrorUrl ?? p.references.mirrorUrl;

  // HCS: only the verifier can write to the topic, so its receipts anchor the passport.
  let receipts: Awaited<ReturnType<typeof readJobReceipts>> = [];
  try {
    receipts = await readJobReceipts(mirrorUrl, p.references.hcsTopic, p.jobId);
  } catch (err) {
    add("HCS receipts found", false, (err as Error).message);
    return;
  }
  const of = <T extends string>(t: T) => receipts.map((m) => m.receipt).filter((r) => r.t === t);
  const job = of("job")[0];
  add("HCS: job commitment matches", job?.t === "job" && job.commitment === p.canaries.commitment && lower(job.buyer) === lower(p.buyer.address), job ? undefined : "no job receipt");
  if (p.agreement) add("HCS: agreement matches what was committed before work", job?.t === "job" && job.agreement === agreementHash(p.agreement));
  const reveal = of("reveal")[0];
  add("HCS: canary reveal matches", reveal?.t === "reveal" && reveal.salt === p.canaries.salt && JSON.stringify(reveal.canaries) === JSON.stringify(p.canaries.revealed));
  if (p.canaries.known) {
    const k = p.canaries.known;
    add(
      "HCS: known answers committed before work and revealed after",
      job?.t === "job" && job.known === k.commitment && reveal?.t === "reveal" && reveal.knownSalt === k.salt && canonicalJson(reveal.known) === canonicalJson(k.placements),
    );
    const knownReceipts = new Set(of("known").map((r) => (r.t === "known" ? `${r.idx}|${lower(r.provider)}|${r.correct}|${r.pass}` : "")));
    const missingKnown = k.checked.filter((c) => !knownReceipts.has(`${c.idx}|${lower(c.provider)}|${c.correct}|${c.pass}`)).map((c) => c.idx);
    add("HCS: a receipt for every known-answer check", missingKnown.length === 0, missingKnown.length ? `missing ${missingKnown.slice(0, 5).join(",")}` : `${k.checked.length} checks`);
  }
  const chunkReceipts = new Set(of("chunk").map((r) => (r.t === "chunk" ? `${r.idx}|${lower(r.provider)}|${r.resultHash}|${r.payTx}` : "")));
  const missing = p.work.filter((w) => !chunkReceipts.has(`${w.idx}|${lower(w.provider)}|${w.resultHash}|${w.payTx}`)).map((w) => w.idx);
  add("HCS: a receipt for every chunk", missing.length === 0, missing.length ? `missing ${missing.slice(0, 5).join(",")}` : `${p.work.length} chunks`);
  const slashed = p.providers.filter((x) => x.status === "slashed" && x.vaultTx);
  // A quorum slash has a proposal receipt (by slash id) and, once settled, a settle receipt
  // naming the transaction that paid the refund. Older slashes have one receipt with that tx.
  const proposals = new Set(of("slash").map((r) => (r.t === "slash" ? (r.slashId ?? r.vaultTx) : "")));
  const settlements = new Map<string, { vaultTx: string; outcome: string; refund: string }>();
  for (const r of of("settle")) if (r.t === "settle") settlements.set(r.slashId, r);
  const unreceipted = slashed.filter((x) => {
    if (!x.slashId) return !proposals.has(x.vaultTx!);
    const settle = settlements.get(x.slashId);
    const settledHere = settle !== undefined && settle.vaultTx === x.vaultTx && settle.outcome === x.slashStatus && settle.refund === x.refund;
    return !proposals.has(x.slashId) || (x.slashStatus !== "proposed" && x.slashStatus !== "disputed" && !settledHere);
  });
  add("HCS: a receipt for every slash", unreceipted.length === 0, unreceipted.length ? unreceipted.map((x) => x.name).join(", ") : `${slashed.length} slashed`);
  await checkAnchorAndSpotOnline(p, opts, receipts, add);

  // A model job: the job receipt named the model, the royalty has its receipt and reached the
  // creator, and the Model Passport on 0G Storage is the one the job ran against.
  if (p.model) {
    const m = p.model;
    add("HCS: the job was registered for this model", job?.t === "job" && job.model === m.key);
    if (m.royalty) {
      const r = of("royalty")[0];
      add("HCS: royalty receipt matches", r?.t === "royalty" && r.model === m.key && r.tx === m.royalty.tx && r.amount === m.royalty.amount && r.basis === m.royalty.basis && r.payTo === m.payTo);
      const credited = await creditedAmount(mirrorUrl, m.royalty.tx, m.payTo, p.payment.id, 2).catch(() => 0n);
      add("mirror node: the royalty reached the creator", credited >= BigInt(m.royalty.amount), `${formatHbar(credited)} to ${m.payTo}`);
    }
    if (!p.references.storageGateway || !isStorageRef(m.passportRef)) {
      add("0G Storage: the Model Passport is the one the job ran against", null, "this passport predates 0G Storage, so its Model Passport reference can't be fetched");
    } else {
      try {
        const res = await fetch(storageUrl(p.references.storageGateway, m.passportRef));
        if (!res.ok) throw new Error(`0G Storage answered ${res.status}`);
        const mp = (await res.json()) as ModelPassport;
        add("0G Storage: the Model Passport is the one the job ran against", modelPassportDigest(mp) === m.passportDigest && mp.key === m.key, m.passportRef.slice(0, 12) + "…");
      } catch (err) {
        add("0G Storage: Model Passport reachable", false, (err as Error).message);
      }
    }
  }

  // Payments: each chunk payment reached its provider on the ledger.
  const payTo = new Map(p.providers.map((x) => [lower(x.address), x.payTo ?? x.address]));
  let unpaid: number | undefined;
  for (const w of p.work) {
    if (!w.payTx) continue;
    const credited = await creditedAmount(mirrorUrl, w.payTx, payTo.get(lower(w.provider)) ?? w.provider, p.payment.id, 2);
    if (credited <= 0n) {
      unpaid = w.idx;
      break;
    }
  }
  add("mirror node: every chunk payment settled", unpaid === undefined, unpaid === undefined ? undefined : `chunk ${unpaid}`);

  // Vault: each slash stands where the passport says, and the co-signer is one of the vault's verifiers.
  try {
    const vault = vaultReader(p, opts);
    const wrong = [];
    for (const x of slashed) {
      if (x.slashId) {
        const status = await vault.slashStatus(x.slashId as Hex);
        if (status !== x.slashStatus) wrong.push(`${x.name} is ${status}, not ${x.slashStatus}`);
        else if (status === "executed" && !(await vault.slashed(x.address))) wrong.push(`${x.name} is not marked slashed`);
      } else if (!(await vault.slashed(x.address))) wrong.push(`${x.name} is not marked slashed`);
    }
    add("vault: every slash stands where the passport says", wrong.length === 0, wrong.join(", ") || undefined);
    const verifiers = await vault.verifiers();
    add("vault: the co-signer is one of the vault's verifiers", verifiers.includes(lower(p.attestations.verifier?.address)), `${verifiers.length} verifiers`);
  } catch (err) {
    add("vault reachable", false, (err as Error).message);
  }
}

const SLASH_STATUSES = ["none", "proposed", "disputed", "executed", "overturned", "cancelled"] as const;

type SeedRecord = { seed: string; drawnAt: number } | undefined;

function vaultReader(
  p: Passport,
  opts: VerifyOptions,
): { slashed: (a: string) => Promise<boolean>; slashStatus: (id: Hex) => Promise<string>; verifiers: () => Promise<string[]>; seed: (tag: Hex) => Promise<SeedRecord> } {
  const devnetUrl = p.references.devnetUrl;
  if (p.network === "devnet" && devnetUrl) {
    const get = async <T>(path: string) => (await (await fetch(`${devnetUrl}/devnet/vault/${path}`)).json()) as T;
    return {
      slashed: async (a) => (await get<{ slashed: boolean }>(`bonds/${a.toLowerCase()}`)).slashed,
      slashStatus: async (id) => (await get<{ status: string }>(`slashes/${id}`)).status,
      verifiers: async () => (await get<{ verifiers: string[] }>("info")).verifiers,
      seed: async (tag) => {
        const s = await get<{ seed: string | null; drawnAt: number }>(`seeds/${tag.toLowerCase()}`);
        return s.seed ? { seed: s.seed, drawnAt: s.drawnAt } : undefined;
      },
    };
  }
  const address = p.references.vault as Hex | undefined;
  if (!address) throw new Error("no vault address in the passport");
  const client = createPublicClient({ chain: hederaTestnet, transport: http(opts.jsonRpcUrl ?? "https://testnet.hashio.io/api") });
  // Passports from before quorum slashing name the old single-arbiter vault.
  const legacy = (fn: () => Promise<unknown>) => fn().then(() => false, () => true);
  const isLegacy = legacy(() => client.readContract({ address, abi: VAULT_ABI, functionName: "verifiers" }));
  return {
    slashed: async (a) =>
      (await isLegacy)
        ? (await client.readContract({ address, abi: LEGACY_VAULT_ABI, functionName: "bondOf", args: [a as Hex] }))[2]
        : (await client.readContract({ address, abi: VAULT_ABI, functionName: "bondOf", args: [a as Hex] }))[2],
    slashStatus: async (id) => SLASH_STATUSES[Number((await client.readContract({ address, abi: VAULT_ABI, functionName: "slashes", args: [id] }))[10])] ?? "none",
    verifiers: async () =>
      (await isLegacy)
        ? [(await client.readContract({ address, abi: LEGACY_VAULT_ABI, functionName: "arbiter" })).toLowerCase()]
        : (await client.readContract({ address, abi: VAULT_ABI, functionName: "verifiers" })).map((v) => v.toLowerCase()),
    seed: async (tag) => {
      const [seed, at] = await client.readContract({ address, abi: VAULT_ABI, functionName: "seeds", args: [tag] });
      return at > 0n ? { seed, drawnAt: Number(at) } : undefined;
    },
  };
}

const LEGACY_VAULT_ABI = parseAbi(["function bondOf(address provider) view returns (uint256 amount, uint64 unlockAt, bool slashed)", "function arbiter() view returns (address)"]);
