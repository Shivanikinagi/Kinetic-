import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeAgreement, type AgreementInput, type GoldItem } from "../core/agreement.js";
import { parseTier } from "../core/tiers.js";
import type { Item, TaskSpec } from "../types.js";
import { formatAmount, formatHbar, isHbar } from "../types.js";
import { jsonReplacer } from "../util/crypto.js";
import type { JobReport } from "./buyer.js";

/** Command-line options for a job's agreed rules (see agreementFromFlags). */
export const AGREEMENT_FLAGS = {
  "check-rate": { type: "string" },
  "pass-mark": { type: "string" },
  gold: { type: "string" },
  "min-accuracy": { type: "string" },
  deadline: { type: "string" },
  tier: { type: "string" },
} as const;

/**
 * --check-rate 0.5 (share of chunks checked), --pass-mark 0.9 (agreement a checked chunk needs),
 * --gold my-examples.jsonl and --min-accuracy 0.9 (admit providers on your own labelled
 * examples), --deadline 600 (seconds), --tier basic|standard|high|confidential → the buyer's
 * terms for the job agreement.
 */
export function agreementFromFlags(f: { "check-rate"?: string; "pass-mark"?: string; gold?: string; "min-accuracy"?: string; deadline?: string; tier?: string }): AgreementInput {
  const num = (v: string | undefined, name: string) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number, got ${v}`);
    return n;
  };
  const gold = f.gold
    ? readFileSync(f.gold, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as GoldItem)
    : undefined;
  const terms: AgreementInput = {
    canaryRate: num(f["check-rate"], "check-rate"),
    minAgreement: num(f["pass-mark"], "pass-mark"),
    goldSet: gold,
    minAccuracy: num(f["min-accuracy"], "min-accuracy"),
    deadlineSeconds: num(f.deadline, "deadline"),
    tier: f.tier ? parseTier(f.tier) : undefined,
  };
  return Object.fromEntries(Object.entries(terms).filter(([, v]) => v !== undefined)) as AgreementInput;
}

/**
 * A task and its items. `taskPath` may be a task folder (data/tasks/<task>/ with task.json and
 * items.jsonl), whose own items are used unless `itemsPath` is given.
 */
export function loadJob(taskPath: string, itemsPath?: string): { task: TaskSpec; items: Item[] } {
  const dir = existsSync(taskPath) && statSync(taskPath).isDirectory() ? taskPath : undefined;
  const task = JSON.parse(readFileSync(dir ? join(dir, "task.json") : taskPath, "utf8")) as TaskSpec;
  itemsPath ??= dir ? join(dir, "items.jsonl") : "data/tickets.jsonl";
  const items = readFileSync(itemsPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Item);
  return { task, items };
}

/** "net 0.0244 ℏ" when everything is HBAR; otherwise the spend and the HBAR refund side by side. */
export function netCost(r: JobReport): string {
  if (isHbar(r.asset)) return `net ${formatHbar(r.paidTinybar - r.refundedTinybar + r.verificationFeeTinybar + (r.royaltyTinybar ?? 0n))}`;
  return `spent ${formatAmount(r.paidTinybar + r.verificationFeeTinybar, r.asset)}, ${formatHbar(r.refundedTinybar)} back`;
}

export function printReport(r: JobReport): void {
  const amt = (units: bigint) => formatAmount(units, r.asset);
  console.log("");
  console.log(`  job ${r.jobId}: ${r.status.toUpperCase()}  ${r.completed}/${r.chunks} chunks`);
  console.log(`  providers paid ${amt(r.paidTinybar)} · refunded ${formatHbar(r.refundedTinybar)} · verifier fee ${amt(r.verificationFeeTinybar)} · ${netCost(r)}`);
  console.log(`  canary failures ${r.canaryFailures} · rerouted ${r.rerouted} (${r.rechecked} rechecked after quarantine) · canaries ${r.canaries.join(",")}`);
  if (r.model) {
    const paid = r.model.royalty ? `${formatHbar(BigInt(r.model.royalty.amount))} royalty paid to ${r.model.payTo} (${r.model.royalty.tx})` : "no royalty paid";
    console.log(`  model ${r.model.id}@${r.model.version} (${r.model.key}) · ${r.model.royaltyBps / 100}% to its creator · ${paid}`);
  }
  console.log("");
  console.log(`  agreed before work (hash on HCS): ${describeAgreement(r.agreement).join("; ")}`);
  console.log(`  agreement ${r.outcome.met ? "MET" : "NOT MET"}: ${r.outcome.notes.join("; ")}`);
  console.log("");
  console.log(`  providers chosen by ${r.strategy} ranking (price, track record, speed; score 0-1)`);
  console.log("  provider        score  admission     status       served  kept  paid            refund");
  for (const p of r.providers) {
    const q = p.qualification;
    const admission = !q ? "—" : q.skipped ? "n/a" : `${q.admitted ? "✓" : "✗"} ${Math.round(q.agreement * 100)}% known`;
    const score = p.rank ? p.rank.score.toFixed(2) : "—";
    const status = p.promoted ? `${p.status}*` : p.status;
    console.log(
      `  ${p.name.padEnd(15)} ${score.padEnd(6)} ${admission.padEnd(13)} ${status.padEnd(12)} ${String(p.served).padStart(6)}  ${String(p.kept).padStart(4)}  ${amt(p.paidTinybar).padEnd(15)} ${formatHbar(p.refundTinybar)}${p.undeliveredTinybar ? `  (${amt(p.undeliveredTinybar)} paid, undelivered)` : ""}${p.vaultTx ? `  (${p.vaultTx})` : ""}`,
    );
  }
  if (r.providers.some((p) => p.promoted)) console.log("  * started as a reserve and stepped in when another provider dropped out");
  console.log("");
  const { coverage, attested } = r.passport;
  console.log(`  Compute Passport on Swarm: ${r.passport.url}`);
  console.log(`  ${attested ? "signed by the buyer and co-signed by the verifier" : "signed by the buyer only (the verifier did not co-sign)"} · ${coverage.verified} of ${r.chunks} chunks checked against 0G`);
  console.log(`  check it: npm run passport:verify -- ${r.passport.ref} --results out/${r.jobId}.json`);
  console.log("");
}

export function writeReport(r: JobReport, dir = "out"): string {
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${r.jobId}.json`;
  writeFileSync(path, JSON.stringify(r, jsonReplacer, 2));
  return path;
}
