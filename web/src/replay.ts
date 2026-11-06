import type { AgentInfo, CanaryResult, Entity, ItemOutput, Kind, ModelCard, ModelListing, ModelPassport, Receipt, Run, Status } from "./data";

// Synthetic replay: a stand-in for the verifier, Arkiv, the mirror node and the agent API, for
// when the live networks can't be reached. It runs entirely in the browser and makes no
// network calls. Its providers, prices, policy and outcomes follow real testnet runs (see
// out/job-mvuj3yuh-f230e4.json), but every transaction id, hash and request id is invented,
// so none of them link anywhere. The dashboard shows a "synthetic replay" badge throughout.
//
// The whole state is a pure function of the clock: each job is a fixed list of timed events,
// and every read replays the events that are due. Nothing drifts, and reloads are safe.

const VERIFIER = "0xa19cc96ea9f0e414cebb149918e4c5549554adc8";
const COSIGNER = "0x5c1e0b7a3f2d94e86b0c7f1a2d3e4b5c6d7e8f90";
const ZG_NODE = "0x3feE5a4dd5FDb8a32dDA97Bed899830605dBD9D3";
const BOND = 50_000_000;
const FEE_PER_CHUNK = 10_000;
const ITEMS_PER_CHUNK_MIN_CHUNKS = 8;

/** Seconds of replay per second of the script; `?speed=2` halves every gap. */
const SPEED = (() => {
  try {
    const v = Number(new URLSearchParams(location.search).get("speed"));
    return v > 0 ? v : 1;
  } catch {
    return 1;
  }
})();

type Name = "BluePeak" | "Riverstone" | "QuickCompute" | "EdgeRelay" | "BudgetGPU";

const PROVIDERS: Record<Name, { addr: string; price: number; backend: string; adversarial?: string; latency: number }> = {
  BluePeak: { addr: "0x7db49eb7d37ba00de37518f26b704c57ebecf5ab", price: 100_000, backend: "0g:0gm-1.0-35b-a3b", latency: 5583 },
  Riverstone: { addr: "0x2d3a9cdf8fc2512c71d8393dbf2e2f2c1209fcda", price: 120_000, backend: "0g:0gm-1.0-35b-a3b", latency: 7210 },
  QuickCompute: { addr: "0x29a727ad41ed785ceff13833123d3b33cd1f9005", price: 60_000, backend: "0g:0gm-1.0-35b-a3b", adversarial: "stops calling its model after 1 chunk", latency: 8878 },
  EdgeRelay: { addr: "0xd943e795047d6f8796da522426ec42d84541dccd", price: 80_000, backend: "0g:0gm-1.0-35b-a3b", adversarial: "goes down mid-job, keeping a payment", latency: 8307 },
  BudgetGPU: { addr: "0xded1726fb7db5019c791b65ba3a8ac8788f99208", price: 40_000, backend: "none", adversarial: "never calls a model", latency: 3917 },
};
const NAMES = Object.keys(PROVIDERS) as Name[];
const nameOf = (addr: string) => NAMES.find((n) => PROVIDERS[n].addr === addr)!;

const LABELS = ["billing", "bug", "account", "shipping", "feature_request", "other"];

// ── Deterministic fake identifiers ──

function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
const hex = (r: () => number, n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join("");
const uuid = (r: () => number) => `${hex(r, 8)}-${hex(r, 4)}-4${hex(r, 3)}-a${hex(r, 3)}-${hex(r, 12)}`;
const txId = (r: () => number, at: number) => `0.0.9185802@${Math.floor(at / 1000)}.${String(Math.floor(r() * 1e9)).padStart(9, "0")}`;
const tsOf = (at: number) => `${Math.floor(at / 1000)}.${String((at % 1000) * 1e6).padStart(9, "0")}`;

// ── A job as a list of timed events ──

interface ChunkState {
  idx: number;
  status: "pending" | "claimed" | "done" | "verified";
  provider: string;
}

interface JobState {
  id: string;
  task: string;
  status: "running" | "complete" | "halted";
  total: number;
  rerouted: number;
  auditRef?: string;
  chunks: ChunkState[];
  canaries: CanaryResult[];
}

/** What the events of every job build up. Rebuilt from scratch on each read. */
interface World {
  receipts: Omit<Receipt, "seq">[];
  jobs: Map<string, JobState>;
  offline: Set<Name>;
  slashed: Set<Name>;
  rep: Map<Name, { pass: number; fail: number; qual?: { admitted: boolean; agreement: number }; latency?: number }>;
  runs: Map<string, Run>;
}

interface Event {
  at: number;
  apply: (w: World) => void;
}

interface Script {
  runId: string;
  jobId: string;
  startedAt: number;
  events: Event[];
}

function itemsFor(jobId: string, idx: number, size: number): ItemOutput[] {
  const r = rng(`${jobId}/${idx}`);
  return Array.from({ length: size }, (_, k) => ({ id: `t${String(idx * size + k + 1).padStart(3, "0")}`, label: LABELS[Math.floor(r() * 5)] }));
}

/**
 * The story, scaled to the job's size. With QuickCompute and EdgeRelay in the pool:
 * BudgetGPU fails admission; QuickCompute does its first chunk honestly, then answers without its model,
 * fails three hidden canaries and is slashed (2 of 3 verifiers sign), and all its chunks are
 * redone elsewhere; EdgeRelay takes payment for a chunk and goes down, and that chunk is rerouted.
 * Once QuickCompute is slashed and EdgeRelay is offline, later jobs run cleanly on BluePeak and Riverstone.
 */
function buildScript(opts: { runId: string; jobId: string; startedAt: number; preset: string; items: number; chunkSize: number; maxSpend: string; strategy: string; tier: string; pool: Name[] }): Script {
  const { jobId, startedAt } = opts;
  const r = rng(jobId);
  const total = Math.max(ITEMS_PER_CHUNK_MIN_CHUNKS, Math.ceil(opts.items / Math.max(1, opts.chunkSize)));
  const size = Math.max(1, opts.chunkSize);
  const events: Event[] = [];
  const at = (sec: number, apply: (w: World) => void) => events.push({ at: startedAt + (sec * 1000) / SPEED, apply });
  const job = (w: World) => w.jobs.get(jobId)!;
  const chunk = (w: World, idx: number) => job(w).chunks[idx];
  const emit = (w: World, body: Record<string, unknown>, dt = 0) => w.receipts.push({ ts: tsOf(Math.round(applyingAt + (dt * 1000) / SPEED)), ...body } as Omit<Receipt, "seq">);
  const run = (w: World) => w.runs.get(opts.runId)!;

  const admitted = opts.pool.filter((n) => n !== "BudgetGPU");
  const adversarial = admitted.includes("QuickCompute") && admitted.includes("EdgeRelay");
  const honest: Name[] = ["BluePeak", "Riverstone"];

  // ── 1. Admission probes (known answers) ──
  opts.pool.forEach((n, i) => {
    const sec = 1 + i * 0.9;
    at(sec, (w) => {
      const ok = n !== "BudgetGPU";
      const rep = w.rep.get(n)!;
      rep.qual = { admitted: ok, agreement: ok ? 1 : 0 };
      rep.latency ??= PROVIDERS[n].latency;
      emit(w, { t: "qualify", provider: PROVIDERS[n].addr, admitted: ok, agreement: ok ? 1 : 0, latencyMs: PROVIDERS[n].latency, ...(ok ? {} : { reason: "matched 0% of known answers" }) });
    });
  });

  // ── 2. Register the job and commit the canary set ──
  const regSec = 1.5 + opts.pool.length * 0.9;
  const plan: Name[] = [];
  const canarySet = new Set<number>();
  if (adversarial) {
    // BluePeak 0,5 · QuickCompute 1,4,6,7 · Riverstone 2 · EdgeRelay 3, then BluePeak and Riverstone in turn.
    const head: Name[] = ["BluePeak", "QuickCompute", "Riverstone", "EdgeRelay", "QuickCompute", "BluePeak", "QuickCompute", "QuickCompute"];
    for (let i = 0; i < total; i++) plan.push(head[i] ?? honest[i % 2]);
    [0, 2, 4, 6, 7].forEach((i) => canarySet.add(i));
  } else {
    for (let i = 0; i < total; i++) plan.push(honest[i % 2]);
    for (let i = 1; i < total; i += 4) canarySet.add(i);
  }
  const canaries = [...canarySet].sort((a, b) => a - b);
  const commitment = hex(r, 64);
  at(regSec, (w) => {
    w.jobs.set(jobId, { id: jobId, task: opts.preset, status: "running", total, rerouted: 0, chunks: Array.from({ length: total }, (_, idx) => ({ idx, status: "pending", provider: "" })), canaries: [] });
    run(w).jobId = jobId;
    run(w).status = "running";
    emit(w, { t: "job", job: jobId, chunks: total, commitment });
  });

  // ── 3–5. Claim, pay, check ──
  const paid = new Map<Name, number>();
  let paidTotal = 0;
  const fee = FEE_PER_CHUNK * total;

  const work = (idx: number, n: Name, claimSec: number, opt: { cheat?: boolean; vanish?: boolean } = {}) => {
    const p = PROVIDERS[n];
    const doneSec = claimSec + 2.6 + r() * 1.4;
    const payTx = txId(r, startedAt + doneSec * 1000);
    paid.set(n, (paid.get(n) ?? 0) + p.price);
    paidTotal += p.price;
    at(claimSec, (w) => {
      Object.assign(chunk(w, idx), { status: "claimed", provider: p.addr });
    });
    at(doneSec, (w) => {
      emit(w, { t: "chunk", job: jobId, idx, provider: p.addr, amount: String(p.price), payTx, zg: ZG_NODE, m: "0gm-1.0-35b-a3b", chat: `chatcmpl-${hex(r, 24)}`, att: "verified" });
      if (opt.vanish) return;
      chunk(w, idx).status = "done";
      emit(w, { t: "known", job: jobId, idx, provider: p.addr, pass: !opt.cheat, correct: opt.cheat ? 0 : 1, items: 1 }, 0.2);
    });
    if (opt.vanish || !canarySet.has(idx)) return doneSec;
    const checkSec = doneSec + 1.5;
    at(checkSec, (w) => {
      const expected = itemsFor(jobId, idx, size);
      const actual = opt.cheat ? expected.map((e) => ({ id: e.id, label: "other" })) : expected;
      const agreement = actual.filter((a, i) => a.label === expected[i].label).length / expected.length;
      const pass = agreement >= 0.8;
      // Invented, like every replay id: the shape of the verifier's own TEE signature check.
      const t = rng(`${jobId}/${idx}/tee`);
      const signedText = `zg-sig-v1/e2ee-ct:${hex(t, 64)}:${hex(t, 64)}`;
      const tee = { trustMode: "private", provider: ZG_NODE.toLowerCase(), providerType: "decentralized" as const, guarantee: "TeeML" as const, chatId: uuid(t), scheme: "zg-sig-v1/e2ee-ct", signedText, signedTextHash: hex(t, 64), signature: `0x${hex(t, 130)}`, signer: `0x${hex(t, 40)}`, verification: "verified" as const, routerTeeVerified: null, costUsdMicro: 178 };
      job(w).canaries.push({ idx, provider: p.addr, agreement, pass, requestId: uuid(r), model: "glm-5.3", zeroGProvider: ZG_NODE, expected, actual, tee });
      if (pass) chunk(w, idx).status = "verified";
      w.rep.get(n)![pass ? "pass" : "fail"] += 1;
      emit(w, { t: "canary", job: jobId, idx, provider: p.addr, pass, agreement });
    });
    return checkSec;
  };

  let last = regSec;
  const cheapoChunks: number[] = [];
  let flickerChunk = -1;
  plan.forEach((n, idx) => {
    const claimSec = regSec + 1 + idx * 1.2;
    if (n === "QuickCompute") cheapoChunks.push(idx);
    if (n === "EdgeRelay") flickerChunk = idx;
    const cheat = n === "QuickCompute" && cheapoChunks.length > 1;
    last = Math.max(last, work(idx, n, claimSec, { cheat, vanish: n === "EdgeRelay" }));
  });

  let rerouteSec = last;
  if (adversarial) {
    // EdgeRelay kept the payment for its chunk and went down: offline, chunk back on the queue.
    const downSec = regSec + 1 + flickerChunk * 1.2 + 5;
    at(downSec, (w) => {
      w.offline.add("EdgeRelay");
      Object.assign(chunk(w, flickerChunk), { status: "pending", provider: "" });
      job(w).rerouted += 1;
    });
    work(flickerChunk, "Riverstone", downSec + 1);

    // QuickCompute's third failed canary: two of three verifiers sign a slash; all its chunks are redone.
    const failSecs = cheapoChunks.slice(1).map((idx) => regSec + 1 + idx * 1.2);
    const slashSec = Math.max(...failSecs) + 6.5;
    const cheapoPaid = cheapoChunks.length * PROVIDERS.QuickCompute.price;
    const slashId = hex(r, 16);
    const vaultTx = txId(r, startedAt + slashSec * 1000);
    at(slashSec, (w) => {
      w.slashed.add("QuickCompute");
      emit(w, { t: "slash", job: jobId, provider: PROVIDERS.QuickCompute.addr, slashId, failures: 3, window: 10, signers: [VERIFIER, COSIGNER], refund: String(cheapoPaid), vaultTx });
      for (const idx of cheapoChunks) Object.assign(chunk(w, idx), { status: "pending", provider: "" });
      job(w).rerouted += cheapoChunks.length;
    });
    cheapoChunks.forEach((idx, i) => {
      rerouteSec = Math.max(rerouteSec, work(idx, honest[i % 2], slashSec + 1 + i * 1.3));
    });
    // The dispute window passes (shortened for the replay) and the vault pays the refund.
    const settleSec = rerouteSec + 2;
    at(settleSec, (w) => {
      emit(w, { t: "settle", job: jobId, provider: PROVIDERS.QuickCompute.addr, slashId, outcome: "executed", refund: String(cheapoPaid), burned: String(BOND - cheapoPaid), vaultTx: txId(r, startedAt + settleSec * 1000) });
    });
    rerouteSec = settleSec;
  }

  // ── 6. Close: reveal the canary set, write the passport ──
  const refunded = adversarial ? cheapoChunks.length * PROVIDERS.QuickCompute.price : 0;
  const closeSec = rerouteSec + 2;
  const auditRef = hex(r, 64);
  at(closeSec, (w) => {
    const j = job(w);
    emit(w, { t: "reveal", job: jobId, canaries });
    emit(w, { t: "done", job: jobId, verified: total, paid: String(paidTotal), refunded: String(refunded), fee: String(fee) }, 0.3);
    j.status = "complete";
    j.auditRef = auditRef;
    const ru = run(w);
    ru.status = "complete";
    ru.finishedAt = applyingAt;
    const checked = new Set(j.canaries.filter((c) => c.pass).map((c) => c.idx)).size;
    ru.report = {
      strategy: opts.strategy,
      passport: { ref: auditRef, url: `#/jobs/${jobId}`, attested: true, coverage: { verified: checked, formatOnly: total - checked, share: Number((checked / total).toFixed(3)) } },
      chunks: total,
      providers: opts.pool.map((n) => ({
        name: n,
        status: n === "BudgetGPU" ? "unqualified" : w.slashed.has(n) ? "slashed" : w.offline.has(n) ? "offline" : "active",
        // Balanced choice before the job: price, track record and speed (cheap and unproven ranks mid-table).
        rank: { score: { BluePeak: 0.82, Riverstone: 0.74, EdgeRelay: 0.61, QuickCompute: 0.58, BudgetGPU: 0 }[n] },
      })),
      agreement: { canaryRate: 0.25, minAgreement: 0.8 },
      outcome: {
        met: paidTotal - refunded + fee <= Number(opts.maxSpend),
        notes: [`all ${total} chunks finished within the budget`, `paid ${((paidTotal - refunded + fee) / 1e8).toPrecision(2)} ℏ net of a ${(refunded / 1e8).toPrecision(2)} ℏ refund`],
      },
    };
  });

  return { runId: opts.runId, jobId, startedAt, events };
}

// ── The replay's own state: the scripts and the kill switch ──

const scripts: Script[] = [];
/** When the event being applied happens; receipts take their timestamps from it. */
let applyingAt = 0;
let haltedAt: number | null = null;
let runCounter = 0;

function newIds(at: number) {
  const r = rng(`run-${at}-${runCounter++}`);
  return { runId: `run-${at.toString(36)}`, jobId: `job-${at.toString(36)}-${hex(r, 6)}` };
}

function pool(w: World): Name[] {
  return NAMES.filter((n) => !w.offline.has(n) && !w.slashed.has(n));
}

function launch(params: { preset: string; items: number; chunkSize: number; maxSpend: string; strategy?: string; tier?: string }, startedAt = Date.now()): Run {
  const available = pool(world(startedAt));
  const { runId, jobId } = newIds(startedAt);
  const run: Run = { runId, preset: params.preset, items: params.items, chunkSize: params.chunkSize, maxSpendTinybar: params.maxSpend, status: "starting", startedAt };
  runs0.set(runId, run);
  scripts.push(buildScript({ runId, jobId, startedAt, preset: params.preset, items: params.items, chunkSize: params.chunkSize, maxSpend: params.maxSpend, strategy: params.strategy ?? "balanced", tier: params.tier ?? "standard", pool: available }));
  return { ...run };
}

/** Run records as first created; the events fill in job id, status and report. */
const runs0 = new Map<string, Run>();

function world(now = Date.now()): World {
  const w: World = { receipts: [], jobs: new Map(), offline: new Set(), slashed: new Set(), rep: new Map(NAMES.map((n) => [n, { pass: 0, fail: 0 }])), runs: new Map() };
  for (const [id, run] of runs0) w.runs.set(id, { ...run });
  const cutoff = haltedAt === null ? now : Math.min(now, haltedAt);
  const due = scripts.flatMap((s) => s.events).filter((e) => e.at <= cutoff).sort((a, b) => a.at - b.at);
  for (const e of due) {
    applyingAt = e.at;
    e.apply(w);
  }
  if (haltedAt !== null) {
    for (const run of w.runs.values()) if (run.status === "running" || run.status === "starting") run.status = "halted";
    for (const j of w.jobs.values()) if (j.status === "running") j.status = "halted";
  }
  return w;
}

// A clean, finished job from before the demo, so the dashboard isn't empty: BluePeak and Riverstone
// only (QuickCompute and EdgeRelay weren't picked), BudgetGPU rejected at admission.
{
  const startedAt = Date.now() - 2 * 3600_000;
  const { runId, jobId } = newIds(startedAt);
  runs0.set(runId, { runId, preset: "classify-tickets", items: 24, chunkSize: 3, maxSpendTinybar: "50000000", status: "starting", startedAt });
  scripts.push(buildScript({ runId, jobId, startedAt, preset: "classify-tickets", items: 24, chunkSize: 3, maxSpend: "50000000", strategy: "balanced", tier: "standard", pool: ["BluePeak", "Riverstone", "BudgetGPU"] }));
}

// ── The data.ts surface ──

export function replayStatus(): Status {
  const w = world();
  const canaryCount = [...w.jobs.values()].reduce((a, j) => a + j.canaries.length, 0);
  const closed = w.receipts.filter((r) => r.t === "done");
  return {
    network: "testnet",
    verifier: VERIFIER,
    hcsTopic: "0.0.11212792",
    vault: "0x11d76cec886b06d5f8e7f4e7d9a5fa2c9808b294",
    uaid: `uaid:aid:replay;uid=${VERIFIER}`,
    payment: { asset: "0.0.0", symbol: "HBAR", decimals: 8 },
    mirrorUrl: "",
    arkiv: { app: "kinetic", rpcUrl: "replay://arkiv" },
    policy: { canaryRate: 0.25, window: 10, failLimit: 3, minAgreement: 0.8 },
    zerog: { referenceRuns: canaryCount, spentUsdMicro: canaryCount * 412, model: "glm-5.3", trustMode: "TeeML", balance: null },
    earnings: { feesTinybar: String(closed.reduce((a, r) => a + Number(r.fee), 0)), feePayments: closed.length, feePerChunkTinybar: String(FEE_PER_CHUNK) },
    quorum: { verifiers: [VERIFIER, COSIGNER, COSIGNER_2], threshold: 2, cosigners: 2 },
  };
}

// ── Model hub: one listed model, its card and a Model Passport with invented signatures ──

const COSIGNER_2 = "0x5d3393fa6c0ca4296b28a48d860d4817951d2616";
const REPLAY_MODEL_KEY = "m1224d368648c7aa";
const REPLAY_CARD: ModelCard = {
  kind: "kinetic.model.v1",
  id: "kinetic/ticket-classifier",
  version: "1.0.1",
  name: "Support Ticket Classifier",
  description: "Routes customer support tickets to billing, bug, account, shipping, feature_request or other. Runs on 0G's own TeeML model, so every provider serving it runs on 0G Compute nodes.",
  license: "apache-2.0",
  creator: { address: "0x0cc8c8f5690c7a0eefd447c29e8031f46cebaa0e", payTo: "0.0.11279737" },
  task: { kind: "classify", instructions: "Classify each support ticket into exactly one label.", labels: LABELS.map((name) => ({ name })) },
  runtime: { engine: "0g", model: "0gm-1.0-35b-a3b" },
  royaltyBps: 500,
  createdAt: "2026-11-02T13:31:00.000Z",
};
const REPLAY_PASSPORT_REF = "0c1c437dba588bd77807dcf68e6f04068edca2c1292559926a9953170bdf7935";

function replayModelEntity(): Entity {
  return entity(
    `model-${REPLAY_MODEL_KEY}`,
    VERIFIER,
    { mkey: REPLAY_MODEL_KEY, model_id: REPLAY_CARD.id, version: REPLAY_CARD.version, name: REPLAY_CARD.name, creator: REPLAY_CARD.creator.address, royalty_bps: REPLAY_CARD.royaltyBps, accuracy: 100, engine: "0g", passport_ref: REPLAY_PASSPORT_REF, status: "listed", "task.classify": 1 },
    { card: REPLAY_CARD, passportRef: REPLAY_PASSPORT_REF, passportDigest: "2e86d36d3888a4f0c3f1b9e0d7a5c2b8e6f4a1d3c5b7e9f0a2c4e6b8d0f1a3c5", accuracy: 1, weightsChecked: false, signers: [VERIFIER, COSIGNER, COSIGNER_2] },
  );
}

export function replayModelPassport(listing: ModelListing): ModelPassport {
  const sig = (seed: string) => `0x${hex(rng(seed), 130)}`;
  return {
    kind: "kinetic.model-passport.v1",
    key: listing.key,
    network: "testnet",
    issuedAt: listing.card.createdAt,
    card: listing.card,
    cardDigest: hex(rng(`card-${listing.key}`), 64),
    creatorSignature: sig(`creator-${listing.key}`),
    weights: { checked: false, reason: `Served by 0G (${listing.card.runtime.model}); its weights aren't published.` },
    benchmark: { task: hex(rng("task"), 64), source: "verifier", items: 12, itemsHash: hex(rng("items"), 64), correct: 12, accuracy: 1, minAccuracy: 0.7, ranOn: ["0g:0gm-1.0-35b-a3b (request replay-1)", "0g:0gm-1.0-35b-a3b (request replay-2)"] },
    fingerprint: { task: hex(rng("task"), 64), answers: Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`f${String(i + 1).padStart(3, "0")}`, LABELS[i % LABELS.length]])) },
    references: { hcsTopic: "0.0.11212792", swarmGateway: "replay://swarm" },
    limitations: [
      "The benchmark scored 12 of 12 labelled examples (100%). It measures accuracy on this task, not safety.",
      `Served by 0G (${listing.card.runtime.model}); its weights aren't published. The file checks don't apply; the passport rests on the benchmark and fingerprint.`,
      "The fingerprint is statistical evidence of which model a provider runs, not proof: it is recorded on every admission and never slashes on its own.",
      `Royalty terms (${listing.card.royaltyBps / 100}%) are fixed for version ${listing.card.version}; a new royalty needs a new version.`,
    ],
    attestations: { verifiers: [VERIFIER, COSIGNER, COSIGNER_2].map((address) => ({ address, signature: sig(address) })) },
  };
}

const entity = (key: string, owner: string, attrs: Record<string, string | number>, payload: Record<string, unknown> | null = null): Entity => ({ key, owner, attrs, payload });

export function replayEntities(kind: Kind): Entity[] {
  const w = world();
  switch (kind) {
    case "offer":
      return NAMES.filter((n) => !w.offline.has(n) && !w.slashed.has(n)).map((n) => {
        const p = PROVIDERS[n];
        return entity(`offer-${n}`, p.addr, { provider: p.addr, name: n, gpu: p.backend === "none" ? "no model" : "0G Compute (TeeML)", price: p.price, bond: BOND, ...(p.backend === "none" ? {} : { [`model.${REPLAY_MODEL_KEY}`]: 1 }), ...(p.adversarial ? { adversarial: p.adversarial } : {}) }, { backend: p.backend });
      });
    case "reputation":
      return NAMES.filter((n) => {
        const rep = w.rep.get(n)!;
        return rep.qual || rep.pass + rep.fail > 0;
      }).map((n) => {
        const p = PROVIDERS[n];
        const rep = w.rep.get(n)!;
        const checks = rep.pass + rep.fail;
        return entity(`rep-${n}`, VERIFIER, {
          provider: p.addr,
          name: n,
          gpu: p.backend === "none" ? "no model" : "0G Compute (TeeML)",
          pass: rep.pass,
          fail: rep.fail,
          score: checks === 0 ? 100 : Math.round((rep.pass / checks) * 100),
          latency_ms: rep.latency ?? p.latency,
          ...(rep.qual ? { qual_status: rep.qual.admitted ? "admitted" : "rejected", qual_agreement: Math.round(rep.qual.agreement * 100) } : {}),
          ...(w.slashed.has(n) ? { status: "slashed" } : {}),
          ...(p.adversarial ? { adversarial: p.adversarial } : {}),
        });
      });
    case "job":
      return [...w.jobs.values()].map((j) =>
        entity(`job-${j.id}`, "buyer", { job_id: j.id, task: j.task, status: j.status, total: j.total, done: j.chunks.filter((c) => c.status === "done" || c.status === "verified").length, rerouted: j.rerouted, fee: FEE_PER_CHUNK * j.total, ...(j.auditRef ? { audit_ref: j.auditRef } : {}) }),
      );
    case "chunk":
      return [...w.jobs.values()].flatMap((j) => j.chunks.map((c) => entity(`chunk-${j.id}-${c.idx}`, "buyer", { job_id: j.id, idx: c.idx, status: c.status, provider: c.provider })));
    case "claim":
      return [...w.jobs.values()].flatMap((j) => j.chunks.filter((c) => c.status === "claimed").map((c) => entity(`claim-${j.id}-${c.idx}`, "buyer", { job_id: j.id, idx: c.idx, provider: c.provider })));
    case "model":
      return [replayModelEntity()];
  }
}

/** Newest first, numbered in time order like an HCS topic. */
export function replayReceipts(): Receipt[] {
  const w = world();
  return w.receipts
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Number(a.r.ts) - Number(b.r.ts) || a.i - b.i)
    .map(({ r }, i) => ({ ...r, seq: i + 1 }) as Receipt)
    .reverse();
}

export function replayCanaries(jobId: string): CanaryResult[] {
  return world().jobs.get(jobId)?.canaries ?? [];
}

export function replayAgentInfo(): AgentInfo {
  return {
    presets: [
      { id: "classify-tickets", kind: "classify" },
      { id: "sentiment", kind: "classify" },
      { id: "ticket-tags", kind: "tag" },
    ],
    maxItems: 120,
    defaults: { maxPricePerChunk: "500000", maxJobSpend: "50000000" },
    network: "testnet",
    halted: haltedAt !== null,
    asset: { id: "0.0.0", symbol: "HBAR", decimals: 8 },
  };
}

export function replayRuns(): { runs: Run[]; halted: boolean } {
  const w = world();
  return { runs: [...w.runs.values()].sort((a, b) => b.startedAt - a.startedAt), halted: haltedAt !== null };
}

export function replayStart(body: { preset?: string; model?: string; texts?: string[]; items: number; chunkSize: number; maxSpendTinybar: string; strategy?: string; agreement?: { tier?: string } }): Run {
  if (haltedAt !== null) throw new Error("Paid work is halted. Resume first.");
  const run = launch({ preset: body.preset ?? "classify-tickets", items: body.texts?.length || body.items, chunkSize: body.chunkSize, maxSpend: body.maxSpendTinybar, strategy: body.strategy, tier: body.agreement?.tier });
  if (body.model === REPLAY_MODEL_KEY) run.model = { key: REPLAY_MODEL_KEY, id: REPLAY_CARD.id, version: REPLAY_CARD.version };
  return run;
}

export function replayHalt(halted: boolean): { halted: boolean } {
  if (halted && haltedAt === null) haltedAt = Date.now();
  if (!halted && haltedAt !== null) {
    // Resuming shifts every pending event by the time spent halted.
    const pause = Date.now() - haltedAt;
    for (const s of scripts) for (const e of s.events) if (e.at > haltedAt) e.at += pause;
    haltedAt = null;
  }
  return { halted: haltedAt !== null };
}
