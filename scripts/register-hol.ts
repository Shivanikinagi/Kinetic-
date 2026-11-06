import "../src/env.js";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { parseArgs, parseEnv } from "node:util";
import { identityFromEnv } from "../src/config.js";
import { loadRoleEnv, roleEnvPath } from "../src/testnet/roles.js";

// Lists a KINETIC provider in the Hashgraph Online agent registry (HCS-10 on Hedera testnet),
// so agents outside KINETIC can find it. Uses the provider's own Hedera account: the SDK
// creates its inbound and outbound topics and its HCS-11 profile, then registers it with the
// guarded registry. Costs a few testnet HBAR from that account.
//
//   npm run register:hol -- --role provider-1     a role from npm run setup:testnet
//   npm run register:hol                           the provider configured in .env
//
// The inbound topic is written to the env file as HOL_INBOUND_TOPIC_ID; the provider then
// publishes it in its Arkiv offer (`hcs10_inbound`). Re-running a listed provider does nothing.

const { values } = parseArgs({ options: { role: { type: "string" } } });
const envFile = values.role ? roleEnvPath(values.role) : ".env";
const env = values.role ? loadRoleEnv(values.role) : process.env;
if (!existsSync(envFile)) throw new Error(`${envFile} not found`);
if (parseEnv(readFileSync(envFile, "utf8")).HOL_INBOUND_TOPIC_ID) {
  console.log(`already listed: HOL_INBOUND_TOPIC_ID is set in ${envFile}`);
  process.exit(0);
}

const identity = identityFromEnv(env);
if (!identity.hederaAccountId) throw new Error("HEDERA_ACCOUNT_ID is required: the listing is paid for and owned by the provider's own account");
const name = env.PROVIDER_NAME || "kinetic-provider";

// The full standards SDK is slow to load, so only this script imports it.
const { AgentBuilder, AIAgentCapability, HCS10Client, InboundTopicType } = await import("@hashgraphonline/standards-sdk");
const client = new HCS10Client({ network: "testnet", operatorId: identity.hederaAccountId, operatorPrivateKey: identity.privateKey.slice(2), logLevel: "warn" });

const builder = new AgentBuilder()
  .setName(name)
  .setAlias(name.toLowerCase().replace(/[^a-z0-9-]/g, "-"))
  .setBio(`KINETIC provider: batch classification, extraction and tagging on ${env.PROVIDER_GPU || "community GPUs"}, paid per chunk over x402 in HBAR, bonded and checked with hidden canaries.`)
  .setCapabilities([AIAgentCapability.TEXT_GENERATION, AIAgentCapability.SUMMARIZATION_EXTRACTION, AIAgentCapability.DATA_INTEGRATION])
  .setType("autonomous")
  .setModel(env.PROVIDER_MODEL || "unknown")
  .setCreator("KINETIC")
  .setNetwork("testnet")
  .setInboundTopicType(InboundTopicType.PUBLIC)
  .setExistingAccount(identity.hederaAccountId, identity.privateKey.slice(2))
  .setMetadata({ type: "autonomous", properties: { endpoint: env.PROVIDER_PUBLIC_URL || "", protocol: "kinetic", payments: "x402 hedera:testnet HBAR" } });

console.log(`registering ${name} (${identity.hederaAccountId}) with the Hashgraph Online registry…`);
const result = await client.createAndRegisterAgent(builder, {
  progressCallback: (p: { stage?: string; message?: string; progressPercent?: number }) => console.log(`  ${p.progressPercent ?? ""}% ${p.message ?? p.stage ?? ""}`),
});
if (!result.success) throw new Error(`registration failed: ${result.error ?? "unknown error"}`);
const inbound = result.state?.inboundTopicId ?? result.metadata?.inboundTopicId;
if (!inbound) throw new Error("registered, but the SDK returned no inbound topic id");

appendFileSync(envFile, `HOL_INBOUND_TOPIC_ID=${inbound}\n`);
console.log(`listed. inbound topic ${inbound}, profile topic ${result.state?.profileTopicId ?? "?"}`);
console.log(`wrote HOL_INBOUND_TOPIC_ID to ${envFile}; restart the provider to publish it in its offer.`);
process.exit(0);
