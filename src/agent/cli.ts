import "../env.js";
import { parseArgs } from "node:util";
import { identityFromEnv, loadNetworkConfig } from "../config.js";
import { connect } from "../integrations/index.js";
import { BuyerAgent, choiceFromEnv } from "./buyer.js";
import { AGREEMENT_FLAGS, agreementFromFlags, loadJob, printReport, writeReport } from "./report.js";

// Buyer agent: `npm run agent -- --task data/classify-tickets.task.json --items data/tickets.jsonl`
// Agreed rules: --check-rate 0.5 --pass-mark 0.9 --gold my-examples.jsonl --min-accuracy 0.9 --deadline 600
// --tier basic|standard|high|confidential

const { values } = parseArgs({
  options: {
    ...AGREEMENT_FLAGS,
    task: { type: "string", default: "data/classify-tickets.task.json" },
    items: { type: "string" },
    chunk: { type: "string", default: "5" },
    "max-price": { type: "string", default: process.env.AGENT_MAX_PRICE_TINYBAR || "500000" },
    "max-spend": { type: "string", default: process.env.AGENT_MAX_JOB_SPEND_TINYBAR || "50000000" },
    verifier: { type: "string", default: process.env.VERIFIER_URL || "http://localhost:4500" },
  },
});

const svc = connect(loadNetworkConfig(), identityFromEnv());

const agent = new BuyerAgent(svc, values.verifier!, {
  maxPricePerChunk: BigInt(values["max-price"]!),
  maxJobSpend: BigInt(values["max-spend"]!),
  allowlist: process.env.AGENT_ALLOWLIST?.split(",").map((a) => a.trim().toLowerCase()),
  ...choiceFromEnv(),
});

const { task, items } = loadJob(values.task!, values.items);
const report = await agent.run({ task, items, chunkSize: Number(values.chunk), agreement: agreementFromFlags(values) });
printReport(report);
console.log(`  report written to ${writeReport(report)}`);
process.exit(report.status === "complete" ? 0 : 1);
