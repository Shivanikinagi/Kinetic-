import type { Tier } from "../core/tiers.js";
import type { AttestationStatus, ZeroGExecution } from "../types.js";

// What a Compute Passport claims about each chunk, kept as two separate questions:
//   authenticity  where and how it ran, and what was attested about that. A TEE signature
//                 says a response came out of a 0G service; it says nothing about whether the
//                 answer is right.
//   correctness   how the answer was checked. Known answers are ground truth; two independent
//                 providers agreeing, or agreeing with a 0G reference model, is consistency; a
//                 format check is only that. None of these says which model ran.
// The summary is derived from the chunks, so anyone can recompute it; the verifier co-signs a
// passport only when it does.

/**
 * The guarantee behind a 0G execution, kept separate because they are not interchangeable:
 * TeeML: the model ran inside a TEE on the 0G node, which signed the response.
 * TeeTLS: a centralized 0G provider's TEE vouches for the TLS route to an outside model; it
 *         does not prove the model ran in a trusted enclave.
 * SPML, OpML, ZKML: as registered by the 0G service, recorded as-is.
 * none: no verifiability, or not run on a named 0G service.
 */
export type ExecutionGuarantee = "TeeML" | "TeeTLS" | "SPML" | "OpML" | "ZKML" | "none";

export function guaranteeOf(verifiability: string | undefined, providerType: ZeroGExecution["providerType"] | undefined): ExecutionGuarantee {
  if (providerType === "centralized") return "TeeTLS";
  if (verifiability === "TeeML" || verifiability === "SPML" || verifiability === "OpML" || verifiability === "ZKML") return verifiability;
  return "none";
}

export interface Authenticity {
  /** 0g-direct: one named 0G Compute service, with its TEE signature checked. 0g-router: 0G's router picked the node. self-hosted: the provider's own server. */
  method: "0g-direct" | "0g-router" | "self-hosted" | "unknown";
  model: {
    declared?: string;
    /** What the 0G service said it served. */
    served?: string;
    /** A hash of the model weights. Null: neither 0G nor an OpenAI-compatible server publishes one. */
    hash: string | null;
  };
  /** The 0G service's on-chain address, when it ran on one directly. */
  node?: string;
  guarantee: ExecutionGuarantee;
  /** The verifier's own check of the TEE signature: never upgraded from "unavailable". */
  attestation: AttestationStatus | "none";
  requestHash?: string;
  responseHash?: string;
}

export interface Correctness {
  methods: ("signature" | "format" | "known-answers" | "redundant-agreement" | "model-agreement")[];
  /** The strongest check the chunk passed. */
  level: "ground-truth" | "redundant-agreement" | "model-agreement" | "format-only";
}

/** What `authenticity` and `correctness` are derived from. */
export interface WorkEvidence {
  check: "verified" | "format";
  execution?: ZeroGExecution;
  attestation?: AttestationStatus;
  known?: { items: number; correct: number };
  redundancy?: { with: string; agreement: number };
}

export function authenticityOf(w: WorkEvidence, declared: string | undefined, verifiability?: string): Authenticity {
  const e = w.execution;
  const method: Authenticity["method"] = e ? "0g-direct" : declared?.startsWith("0g:") ? "0g-router" : declared?.startsWith("openai:") ? "self-hosted" : "unknown";
  return {
    method,
    model: { ...(declared ? { declared } : {}), ...(e ? { served: e.model } : {}), hash: null },
    ...(e ? { node: e.zgProvider } : {}),
    guarantee: e ? guaranteeOf(verifiability ?? e.verifiability, e.providerType) : "none",
    attestation: e ? (w.attestation ?? "unavailable") : "none",
    ...(e?.requestHash ? { requestHash: e.requestHash } : {}),
    ...(e ? { responseHash: e.responseHash } : {}),
  };
}

export function correctnessOf(w: WorkEvidence): Correctness {
  const known = w.known !== undefined && w.known.items > 0 && w.known.correct === w.known.items;
  const redundant = w.redundancy !== undefined;
  const model = w.check === "verified";
  return {
    methods: ["signature", "format", ...(known ? (["known-answers"] as const) : []), ...(redundant ? (["redundant-agreement"] as const) : []), ...(model ? (["model-agreement"] as const) : [])],
    level: known ? "ground-truth" : redundant ? "redundant-agreement" : model ? "model-agreement" : "format-only",
  };
}

export interface PassportSummary {
  /** passed: every chunk finished and was checked beyond its format. partial: finished, some format-only. failed: unfinished. */
  verification: "passed" | "partial" | "failed";
  /** The tier agreed before work, and whether every check it promises ran on every kept chunk. */
  assurance: { tier: Tier; met: boolean; shortfalls: string[] };
  correctness: { groundTruth: number; redundantAgreement: number; modelAgreement: number; formatOnly: number };
  authenticity: { byGuarantee: Record<ExecutionGuarantee, number>; attested: number; unavailable: number; invalid: number; unattested: number };
  knownAnswers: { sampled: number; passed: number };
  modelCanaries: { sampled: number; passed: number };
  /** settled: every kept chunk's x402 payment has a transaction. */
  payments: "settled" | "incomplete";
  slashes: { executed: number; pending: number; overturned: number; cancelled: number };
}

export interface SummaryInput {
  chunks: number;
  work: (WorkEvidence & { authenticity?: Authenticity; correctness?: Correctness; payTx?: string })[];
  known?: { checked: { pass: boolean }[] };
  checked: { pass: boolean }[];
  providers: { status: string; slashStatus?: string; vaultTx?: string }[];
  agreement?: { tier?: Tier; canaryRate: number };
  revealed?: number[];
}

/** What a tier promises that a job's evidence doesn't show. Empty when the tier was met. */
export function shortfallsOf(p: SummaryInput): string[] {
  const tier = p.agreement?.tier ?? "standard";
  if (tier === "basic") return [];
  const out: string[] = [];
  const planned = p.agreement && p.agreement.canaryRate > 0 ? Math.min(p.chunks, Math.max(1, Math.round(p.chunks * p.agreement.canaryRate))) : 0;
  if ((p.revealed?.length ?? 0) < planned) out.push(`${p.revealed?.length ?? 0} canaries, not the ${planned} agreed`);
  if (!p.known) out.push("no known answers were planted (the verifier has no labelled examples for this task)");
  else {
    const without = p.work.filter((w) => (w.correctness ?? correctnessOf(w)).level !== "ground-truth").length;
    if (without) out.push(`${without} kept chunk(s) without a passing known answer`);
  }
  if (tier === "high") {
    const single = p.work.filter((w) => !w.redundancy).length;
    if (single) out.push(`${single} kept chunk(s) without an agreeing independent copy`);
  }
  if (tier === "confidential") {
    const loose = p.work.filter((w) => w.authenticity?.guarantee !== "TeeML" || w.authenticity.attestation !== "verified").length;
    if (loose) out.push(`${loose} kept chunk(s) without a verified TeeML attestation`);
  }
  return out;
}

export function summarize(p: SummaryInput): PassportSummary {
  const levels = p.work.map((w) => (w.correctness ?? correctnessOf(w)).level);
  const count = (l: Correctness["level"]) => levels.filter((x) => x === l).length;
  const auth = p.work.map((w) => w.authenticity);
  const byGuarantee = { TeeML: 0, TeeTLS: 0, SPML: 0, OpML: 0, ZKML: 0, none: 0 } as Record<ExecutionGuarantee, number>;
  for (const a of auth) byGuarantee[a?.guarantee ?? "none"] += 1;
  const slashed = p.providers.filter((x) => x.status === "slashed" && x.vaultTx);
  const status = (s: string) => slashed.filter((x) => (x.slashStatus ?? "executed") === s).length;
  const complete = p.work.length === p.chunks;
  const shortfalls = shortfallsOf(p);
  return {
    verification: !complete ? "failed" : count("format-only") > 0 ? "partial" : "passed",
    assurance: { tier: p.agreement?.tier ?? "standard", met: shortfalls.length === 0, shortfalls },
    correctness: { groundTruth: count("ground-truth"), redundantAgreement: count("redundant-agreement"), modelAgreement: count("model-agreement"), formatOnly: count("format-only") },
    authenticity: {
      byGuarantee,
      attested: auth.filter((a) => a?.attestation === "verified").length,
      unavailable: auth.filter((a) => a?.attestation === "unavailable").length,
      invalid: auth.filter((a) => a?.attestation === "invalid").length,
      unattested: auth.filter((a) => !a || a.attestation === "none").length,
    },
    knownAnswers: { sampled: p.known?.checked.length ?? 0, passed: p.known?.checked.filter((c) => c.pass).length ?? 0 },
    modelCanaries: { sampled: p.checked.length, passed: p.checked.filter((c) => c.pass).length },
    payments: p.work.every((w) => w.payTx) ? "settled" : "incomplete",
    slashes: { executed: status("executed"), pending: status("proposed") + status("disputed"), overturned: status("overturned"), cancelled: status("cancelled") },
  };
}
