import { formatHbar, type Item, type TaskSpec } from "../types.js";
import { canonicalJson, sha256Hex } from "../util/crypto.js";
import type { Quote } from "./quote.js";
import { describeTier, TIERS, type Tier } from "./tiers.js";

// A job agreement: the rules the buyer sets before any chunk runs. The verifier checks them
// when the job registers, the HCS `job` receipt commits to their hash, and the Compute Passport
// carries them, so nobody can change what counts as acceptable work after seeing results.
//
// The buyer's rules decide what the buyer accepts. Slashing still follows the protocol's own
// policy, so a buyer can't cost honest providers their bond by setting a stricter bar.

/** A labelled example the buyer supplies for admission probes. Never published. */
export interface GoldItem extends Item {
  label: string;
}

/** What a buyer asks for. Anything left out falls back to the verifier's policy. */
export interface AgreementInput {
  /** Share of chunks checked against 0G. At least the verifier's own rate. */
  canaryRate?: number;
  /** Pass mark for a checked chunk (agreement with 0G, 0..1). At least the verifier's own. */
  minAgreement?: number;
  /** The buyer's own labelled examples to admit providers with, instead of the verifier's. */
  goldSet?: GoldItem[];
  /** Accuracy a provider needs on the admission examples (0..1). */
  minAccuracy?: number;
  /** No new paid work after this many seconds from the start of the job. */
  deadlineSeconds?: number;
  /** How much verification the job gets (default standard). */
  tier?: Tier;
}

/**
 * A model job's model and its creator's terms, as listed: committed with the rest of the rules, so
 * the royalty can't change after the work. `passport` is the Model Passport's digest.
 */
export interface ModelTerms {
  key: string;
  id: string;
  version: string;
  passport: string;
  passportRef: string;
  royaltyBps: number;
  payTo: string;
}

/** The public form, committed on HCS and carried in the passport. It holds no example contents. */
export interface Agreement {
  v: 1;
  /** sha256 of the task spec (instructions and labels). */
  task: string;
  canaryRate: number;
  minAgreement: number;
  admission: { source: "buyer" | "verifier"; size: number; hash?: string; minAccuracy: number };
  budget: { asset: string; maxSpend: string; maxPricePerChunk: string };
  /** ISO time after which no new paid work starts. */
  deadline?: string;
  /** The firm quote from the live offers: the most this job can cost. budget.maxSpend never exceeds it. */
  quote?: Quote;
  /** The assurance tier. Absent on agreements from before tiers: standard. */
  tier?: Tier;
  /** The listed model the job runs, and its creator's royalty. Absent for jobs that name no model. */
  model?: ModelTerms;
}

export const MAX_GOLD_ITEMS = 200;

export const agreementHash = (a: Agreement) => sha256Hex(canonicalJson(a));
export const goldHash = (items: GoldItem[]) => sha256Hex(canonicalJson(items.map(({ text, label }) => ({ text, label }))));
export const taskHash = (task: TaskSpec) => sha256Hex(canonicalJson(task));

export interface AgreementTerms {
  task: TaskSpec;
  policy: { canaryRate: number; minAgreement: number };
  budget: Agreement["budget"];
  input?: AgreementInput;
  now?: number;
}

/** Turns what the buyer asked for into the agreement both sides sign up to. */
export function makeAgreement({ task, policy, budget, input = {}, now = Date.now() }: AgreementTerms): Agreement {
  const gold = input.goldSet?.length ? input.goldSet : undefined;
  const tier = input.tier ?? "standard";
  return {
    v: 1,
    task: taskHash(task),
    // Basic assurance runs no canaries at all; every other tier at least the protocol's rate.
    canaryRate: tier === "basic" ? 0 : Math.max(policy.canaryRate, input.canaryRate ?? 0),
    minAgreement: Math.max(policy.minAgreement, input.minAgreement ?? 0),
    admission: gold
      ? { source: "buyer", size: gold.length, hash: goldHash(gold), minAccuracy: input.minAccuracy ?? policy.minAgreement }
      : { source: "verifier", size: 0, minAccuracy: Math.max(policy.minAgreement, input.minAccuracy ?? 0) },
    budget,
    ...(input.deadlineSeconds ? { deadline: new Date(now + input.deadlineSeconds * 1000).toISOString() } : {}),
    tier,
  };
}

/** Problems with an agreement, from the verifier's side. Empty when it can be accepted. */
export function agreementProblems(a: Agreement, task: TaskSpec, policy: { canaryRate: number; minAgreement: number }, gold?: GoldItem[]): string[] {
  const problems: string[] = [];
  const inRange = (x: unknown, lo: number) => typeof x === "number" && x >= lo && x <= 1;
  if (a?.v !== 1) return ["unknown agreement version"];
  if (a.task !== taskHash(task)) problems.push("agreement is for a different task");
  if (a.tier !== undefined && !TIERS.includes(a.tier)) problems.push(`unknown assurance tier ${a.tier}`);
  if (a.tier === "basic" ? a.canaryRate !== 0 : !inRange(a.canaryRate, policy.canaryRate)) problems.push(a.tier === "basic" ? "basic assurance runs no canaries" : `check rate must be between ${policy.canaryRate} and 1`);
  if (!inRange(a.minAgreement, policy.minAgreement)) problems.push(`pass mark must be between ${policy.minAgreement} and 1`);
  if (!inRange(a.admission?.minAccuracy, 0.01)) problems.push("admission accuracy must be between 0.01 and 1");
  if (a.admission?.source === "buyer") {
    const labels = new Set((task.labels ?? []).map((l) => l.name));
    if (!gold?.length) problems.push("agreement names buyer examples but none were sent");
    else if (gold.length > MAX_GOLD_ITEMS) problems.push(`at most ${MAX_GOLD_ITEMS} admission examples`);
    else if (task.kind !== "classify" || gold.some((g) => typeof g.text !== "string" || !labels.has(g.label))) problems.push("admission examples need text and one of the task's labels");
    else if (a.admission.hash !== goldHash(gold) || a.admission.size !== gold.length) problems.push("admission examples don't match the agreement");
  } else if (a.admission?.source !== "verifier") problems.push("unknown admission source");
  if (a.deadline !== undefined && Number.isNaN(Date.parse(a.deadline))) problems.push("deadline is not a date");
  return problems;
}

/** One line per rule, for reports. */
export function describeAgreement(a: Agreement): string[] {
  return [
    describeTier(a.tier ?? "standard"),
    ...(a.canaryRate > 0 ? [`check at least ${Math.round(a.canaryRate * 100)}% of chunks against 0G; a checked chunk passes at ${Math.round(a.minAgreement * 100)}% agreement`] : []),
    a.admission.source === "buyer"
      ? `admit providers that score ${Math.round(a.admission.minAccuracy * 100)}% on the buyer's ${a.admission.size} labelled examples`
      : `admit providers that score ${Math.round(a.admission.minAccuracy * 100)}% on the verifier's labelled examples`,
    ...(a.model ? [`run ${a.model.id}@${a.model.version}; its creator gets ${a.model.royaltyBps / 100}% of the payments for accepted chunks`] : []),
    ...(a.deadline ? [`no new paid work after ${a.deadline}`] : []),
    ...(a.quote ? [describeQuote(a.quote, BigInt(a.budget.maxSpend))] : []),
  ];
}

/** "pay at most 0.0270 ℏ: 20 chunks + 5 for reroutes at up to 0.001 ℏ, plus the verifier's 0.002 ℏ fee". */
export function describeQuote(q: Quote, cap: bigint): string {
  const total = BigInt(q.total);
  const head = `pay at most ${formatHbar(cap < total ? cap : total)}`;
  const royalty = q.royalty && q.royalty !== "0" ? ` and up to ${formatHbar(BigInt(q.royalty))} in creator royalties` : "";
  const body = `${q.chunks} chunks + ${q.allowance} for reroutes at up to ${formatHbar(BigInt(q.maxPricePerChunk))} each, plus the verifier's ${formatHbar(BigInt(q.fee))} fee${royalty}`;
  return cap < total ? `${head} (the budget; the quote from live offers was ${formatHbar(total)}: ${body})` : `${head}, quoted from live offers: ${body}`;
}
