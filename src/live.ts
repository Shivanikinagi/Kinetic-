import "./env.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { BuyerAgent, choiceFromEnv } from "./agent/buyer.js";
import { AGREEMENT_FLAGS, agreementFromFlags, loadJob, netCost, printReport, writeReport } from "./agent/report.js";
import { describeAgreement } from "./core/agreement.js";
import { identityFromEnv, loadNetworkConfig } from "./config.js";
import { readReceipts } from "./integrations/hcs.js";
import { connect, connectCosigner } from "./integrations/index.js";
import { startCosigner } from "./verifier/cosigner.js";
import { mirrorTransactionId } from "./integrations/x402.js";
import { backendForEnv, parseBehavior, type ModelBackend } from "./provider/backend.js";
import { startProvider, type RunningProvider } from "./provider/node.js";
import { loadRoleEnv, ROLES } from "./testnet/roles.js";
import { startAgentService } from "./agent/service.js";
import { formatAmount, formatHbar, type TaskKind } from "./types.js";
import { logger } from "./util/log.js";
import { startVerifier } from "./verifier/service.js";
import { modelKey } from "./models/card.js";
import { publishModel, type CardDraft } from "./models/publish.js";
import { resolveModel, type ModelListing } from "./models/registry.js";
import { discoverModels, prepareModels } from "./provider/models.js";

// The full system on real networks: Hedera testnet (x402, HCS, vault), Arkiv (Rabdi),
// 0G Storage, and 0G Private Computer. Every role uses its own account from .kinetic/testnet/
// (npm run setup:testnet). Writes an evidence file with explorer links to out/.

const { values } = parseArgs({
  options: {
    task: { type: "string", default: "data/classify-tickets.task.json" },
    items: { type: "string", default: "36" },
    chunk: { type: "string", default: "3" },
    "canary-rate": { type: "string" },
    serve: { type: "boolean", default: false },
    // With --serve the dashboard starts jobs; --job also runs one job at startup.
    job: { type: "boolean", default: false },
    // Run the job on a listed model ("id", "id@version" or key) instead of a task file.
    model: { type: "string" },
    // The job's agreed rules: --check-rate, --pass-mark, --gold, --min-accuracy, --deadline.
    ...AGREEMENT_FLAGS,
  },
});
const runJobNow = !values.serve || values.job;
const log = logger("live");

// Each provider runs exactly the backend it declares (0G Compute by default). A provider on
// its own server that isn't answering fails to start, rather than quietly running elsewhere.
async function backendFor(env: Record<string, string | undefined>): Promise<ModelBackend> {
  const backend = await backendForEnv(env, loadNetworkConfig(env));
  if ((env.PROVIDER_BACKEND || "0g") === "openai") {
    const url = env.PROVIDER_MODEL_URL || "http://localhost:11434/v1";
    const up = await fetch(`${url.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
    if (!up) throw new Error(`${env.PROVIDER_NAME}: no model server answering at ${url} (PROVIDER_BACKEND=openai)`);
  }
  log(`${env.PROVIDER_NAME} runs ${backend.name}${backend.zgProvider ? ` on 0G Compute provider ${backend.zgProvider}` : ""}`);
  return backend;
}

// The cosigning verifiers first: the verifier asks them to re-check and co-sign every slash.
const cosigners = await Promise.all(
  ROLES.filter((r) => r.cosigner).map(async (r) => {
    const env = loadRoleEnv(r.role);
    const c = await startCosigner(connectCosigner(loadNetworkConfig(env), identityFromEnv(env)), r.cosigner!.port);
    log(`cosigner ${r.role} ${c.cosigner.address} on ${c.url}`);
    return c;
  }),
);

const verifierEnv: Record<string, string | undefined> = { ...loadRoleEnv("verifier") };
if (values["canary-rate"]) verifierEnv.CANARY_RATE = values["canary-rate"];
const verifierSvc = connect(loadNetworkConfig(verifierEnv), identityFromEnv(verifierEnv));
const verifier = await startVerifier(verifierSvc, Number(verifierEnv.VERIFIER_PORT ?? 4500));
log(`verifier ${verifierSvc.address} (${verifierSvc.payTo}) on ${verifier.url}`);

// The model hub: the creator lists every card in data/models/ that isn't listed yet. The verifier
// quorum reviews each one and signs its Model Passport. Needs the creator role (npm run setup:testnet).
const seeded: string[] = [];
// The creator role, also lent to the dashboard's publish screen (testnet demo).
let creatorSvc: ReturnType<typeof connect> | undefined;
const cards = existsSync("data/models") ? readdirSync("data/models").filter((f) => f.endsWith(".card.json")) : [];
if (cards.length > 0) {
  let creatorEnv: Record<string, string | undefined> | undefined;
  try {
    creatorEnv = loadRoleEnv("creator");
  } catch {
    log("model hub: no creator role yet, so no models are published (run npm run setup:testnet once)");
  }
  if (creatorEnv) {
    creatorSvc = connect(loadNetworkConfig(creatorEnv), identityFromEnv(creatorEnv));
    for (const file of cards) {
      const card = JSON.parse(readFileSync(`data/models/${file}`, "utf8")) as CardDraft;
      const key = modelKey(card.id, card.version);
      if (verifier.verifier.models.get(key)) {
        seeded.push(card.id);
        log(`model ${card.id}@${card.version} already listed (${key})`);
        continue;
      }
      try {
        const out = await publishModel(creatorSvc, verifier.url, { card }, (m) => log(m));
        seeded.push(card.id);
        log(`model ${out.id}@${out.version} listed as ${out.key}: benchmark ${Math.round(out.accuracy * 100)}%, signed by ${out.signers.length} verifiers, passport ${out.passportRef}`);
      } catch (err) {
        log(`model ${card.id} not listed: ${(err as Error).message}`);
      }
    }
  }
}

// Listings written to another Arkiv network (after a move) are re-created here before providers
// look them up.
await verifier.verifier.models.renew();

// Providers start in parallel: each is its own account, so their bond and Arkiv writes don't
// share a nonce.
// One provider that can't start (slashed, or its model server down) doesn't stop the others.
const started = await Promise.allSettled(
  ROLES.filter((x) => x.provider).map(async (r) => {
    const env = loadRoleEnv(r.role);
    const svc = connect(loadNetworkConfig(env), identityFromEnv(env));
    const backend = await backendFor(env);
    // Every provider serves the listed models (PROVIDER_MODELS overrides), each checked against its passport first.
    const refs = env.PROVIDER_MODELS !== undefined ? env.PROVIDER_MODELS.split(",").map((m) => m.trim()).filter(Boolean) : seeded;
    // Each listing on its own, so one whose passport can't be fetched (a store that doesn't answer) is
    // skipped instead of leaving the provider with no models.
    const prepared = await Promise.allSettled(refs.map((ref) => prepareModels(svc, { refs: [ref], mainBackend: backend, env })));
    prepared.forEach((p, i) => p.status === "rejected" && log(`${r.provider!.name} skips model ${refs[i]}: ${(p.reason as Error).message}`));
    const served = prepared.flatMap((p) => (p.status === "fulfilled" ? p.value : []));
    const models = served.length ? served : undefined;
    return startProvider(
      {
        name: r.provider!.name,
        port: r.provider!.port,
        gpu: r.provider!.gpu,
        tasks: ["classify", "extract", "tag"] as TaskKind[],
        priceTinybar: r.provider!.priceTinybar,
        bondTinybar: BigInt(env.PROVIDER_BOND_TINYBAR || 100_000_000),
        backend,
        behavior: parseBehavior(env.PROVIDER_BEHAVIOR),
        hcs10Inbound: env.HOL_INBOUND_TOPIC_ID || undefined,
        ...(models?.length ? { models } : {}),
        // Models published while the network runs (from the dashboard, say) are picked up too.
        discoverModels: (known: Set<string>) => discoverModels(svc, known, { mainBackend: backend, env }),
        ...(env.PROVIDER_SANDBOX ? { sandbox: env.PROVIDER_SANDBOX } : {}),
      },
      svc,
    );
  }),
);
const providers: RunningProvider[] = [];
for (const [i, s] of started.entries()) {
  if (s.status === "fulfilled") providers.push(s.value);
  else log(`${ROLES.filter((x) => x.provider)[i].provider!.name} not started: ${(s.reason as Error).message}`);
}
if (providers.length === 0) throw new Error("no provider could start");
log(`${providers.length} providers bonded and offered on Arkiv`);

const shutdown = async () => {
  // Deleting the offers right away, rather than waiting 90 s for them to expire.
  await Promise.all(providers.map((p) => p.close().catch(() => undefined)));
  await verifier.close().catch(() => undefined);
  await Promise.all(cosigners.map((c) => c.close().catch(() => undefined)));
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const buyerEnv = loadRoleEnv("buyer");
const buyerCfg = loadNetworkConfig(buyerEnv);
const buyerSvc = connect(buyerCfg, identityFromEnv(buyerEnv));
const agent = new BuyerAgent(buyerSvc, verifier.url, {
  maxPricePerChunk: BigInt(buyerEnv.AGENT_MAX_PRICE_TINYBAR ?? 500_000),
  maxJobSpend: BigInt(buyerEnv.AGENT_MAX_JOB_SPEND_TINYBAR ?? 200_000_000),
  requestTimeoutMs: 180_000,
  ...choiceFromEnv(buyerEnv),
});

async function runOnce() {
  const job = loadJob(values.task!);
  const model: ModelListing | undefined = values.model ? await resolveModel(buyerSvc.arkiv, (await buyerSvc.vault.info()).verifiers, values.model) : undefined;
  if (model) log(`running model ${model.id}@${model.version} (${model.key}); ${model.card.royaltyBps / 100}% royalty to its creator`);
  const report = await agent.run({ task: model ? model.card.task : job.task, items: job.items.slice(0, Number(values.items)), chunkSize: Number(values.chunk), agreement: agreementFromFlags(values), ...(model ? { model } : {}) });
  printReport(report);
  log(`report written to ${writeReport(report)}`);

  // Evidence for the README: every claim links to a public explorer.
  const receipts = (await readReceipts(buyerCfg.hedera, 100)).map((m) => ({ seq: m.sequence, ...m.receipt })).filter((r) => "job" in r && r.job === report.jobId);
  const hashscanTx = (id: string) => `https://hashscan.io/testnet/transaction/${id.startsWith("0x") ? id : mirrorTransactionId(id)}`;
  const payments = receipts.filter((r) => r.t === "chunk").slice(0, 5);
  const canaries = receipts.filter((r) => r.t === "canary").slice(0, 5);
  const writers = [
    ["buyer (jobs, chunks, claims)", buyerSvc.address],
    ["verifier (reputation)", verifierSvc.address],
    ...providers.map((p) => [`${p.name} (offer)`, p.address]),
  ];
  const md = [
    `# KINETIC live run ${report.jobId}`,
    ``,
    `${report.completed}/${report.chunks} chunks · providers paid ${formatAmount(report.paidTinybar, report.asset)} · refunded ${formatHbar(report.refundedTinybar)} · verifier fee ${formatAmount(report.verificationFeeTinybar, report.asset)} · ${netCost(report)}`,
    `- Agreed before work (hash in the HCS job receipt): ${describeAgreement(report.agreement).join("; ")}`,
    `- Agreement ${report.outcome.met ? "met" : "not met"}: ${report.outcome.notes.join("; ")}`,
    ``,
    `## Hedera`,
    `- HCS receipts topic: https://hashscan.io/testnet/topic/${buyerCfg.hedera.hcsTopicId}`,
    `- Bond vault: https://hashscan.io/testnet/contract/${buyerCfg.hedera.vaultAddress}`,
    report.verificationFeeTx ? `- x402 verification fee (buyer → verifier): ${hashscanTx(report.verificationFeeTx)}` : ``,
    ...payments.map((p) => (p.t === "chunk" ? `- x402 chunk payment #${p.idx}: ${hashscanTx(p.payTx)}` : "")),
    ...report.providers.filter((p) => p.vaultTx).map((p) => `- Slash + refund (${p.name}): ${hashscanTx(p.vaultTx!)}`),
    ...(report.model?.royalty ? [`- x402 creator royalty (buyer → creator of ${report.model.id}): ${hashscanTx(report.model.royalty.tx)}`] : []),
    ...(report.model ? [`- Model Passport (${report.model.id}@${report.model.version}): ${buyerSvc.storage.url(report.model.passportRef)}`] : []),
    ``,
    `## 0G Private Computer (verified reference runs)`,
    ...canaries.map((c) => (c.t === "canary" ? `- canary #${c.idx}: ${c.pass ? "PASS" : "FAIL"} agreement ${c.agreement}, request id \`${c.ref}\`` : "")),
    ...(canaries.some((c) => c.t === "canary") ? [] : [`- no canary was scored (see the passport's limitations)`]),
    ``,
    `## Arkiv (chain ${verifierSvc.cfg.arkiv.chainId})`,
    ...writers.map(([who, addr]) => `- ${who}: ${verifierSvc.cfg.arkiv.explorerUrl}/address/${addr}`),
    `- Query: \`arkiv.schema = str('kinetic.job') AND app = str('${buyerSvc.arkiv.app}') AND job_id = str('${report.jobId}')\``,
    ``,
    `## 0G Storage`,
    report.passport.notStored
      ? `- Compute Passport (${report.passport.attested ? "co-signed by the verifier" : "buyer-signed only"}): signed, but not stored this time (see the verifier's log)`
      : `- Compute Passport (${report.passport.attested ? "co-signed by the verifier" : "buyer-signed only"}): ${report.passport.url}`,
    `- Check it: \`npm run passport:verify -- ${report.passport.ref} --results out/${report.jobId}.json\``,
    ``,
  ].filter((l) => l !== undefined);
  mkdirSync("out", { recursive: true });
  writeFileSync(`out/live-${report.jobId}.md`, md.join("\n"));
  log(`evidence written to out/live-${report.jobId}.md`);
  return report;
}

const report = runJobNow ? await runOnce() : null;

if (values.serve) {
  await startAgentService(buyerSvc, {
    port: 4600,
    verifierUrl: verifier.url,
    defaults: { maxPricePerChunk: BigInt(buyerEnv.AGENT_MAX_PRICE_TINYBAR || 500_000), maxJobSpend: BigInt(buyerEnv.AGENT_MAX_JOB_SPEND_TINYBAR || 200_000_000), requestTimeoutMs: 180_000, ...choiceFromEnv(buyerEnv) },
    maxItems: 60,
    ...(creatorSvc ? { publisher: creatorSvc } : {}),
  });
  log("ready. Dashboard: npm run web, then http://localhost:5173 (start jobs from \"Run a job\") · Ctrl+C to stop");
} else {
  for (const p of providers) await p.close();
  await verifier.close();
  for (const c of cosigners) await c.close();
  process.exit(report?.status === "complete" ? 0 : 1);
}
