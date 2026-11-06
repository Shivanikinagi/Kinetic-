import "../src/env.js";
import { parseArgs } from "node:util";
import { loadNetworkConfig } from "../src/config.js";
import { isPublicGateway, SwarmClient } from "../src/integrations/swarm.js";

// One Swarm upload and one read, through the same client KINETIC uses (arkiv/swarm.md). Needs
// no keys: without BEE_POSTAGE_BATCH_ID it uploads through the public gateway on its own batch.
//
//   npm run swarm:roundtrip -- [--text "hello"]   upload, then download and compare
//   npm run swarm:roundtrip -- --job <jobId>      read a job's Arkiv entity, then its audit_ref on Swarm

const { values } = parseArgs({ options: { text: { type: "string" }, job: { type: "string" } } });
const cfg = loadNetworkConfig(process.env);
const swarm = new SwarmClient(cfg.swarm);
const link = (ref: string) => `${cfg.swarm.gatewayUrl}/bytes/${ref}`;

if (values.job) {
  const query = `arkiv.schema = str('kinetic.job') AND app = str('kinetic') AND job_id = str('${values.job.replace(/'/g, "")}')`;
  const res = await fetch(cfg.arkiv.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "arkiv_query", params: [query, { limit: 1, select: { key: true, attributes: true } }] }),
  });
  const body = (await res.json()) as { result?: { data: { key: string; attributes: { name: string; value: string }[] }[] }; error?: { message: string } };
  if (body.error) throw new Error(`arkiv_query: ${body.error.message}`);
  const entity = body.result?.data[0];
  if (!entity) throw new Error(`no kinetic.job entity for ${values.job} on Arkiv (job entities expire after 7 days)`);
  const ref = entity.attributes.find((a) => a.name === "audit_ref")?.value;
  console.log(`Arkiv entity  ${entity.key}`);
  console.log(`              ${cfg.arkiv.explorerUrl}/entity/${entity.key}`);
  if (!ref) throw new Error("the job has no audit_ref yet (it is set when the job finishes)");
  console.log(`audit_ref     ${ref}`);
  const bytes = await swarm.download(ref);
  const passport = JSON.parse(new TextDecoder().decode(bytes)) as { jobId?: string };
  console.log(`Swarm read    ${bytes.length} bytes, every chunk checked against its content address`);
  console.log(`              ${link(ref)}`);
  console.log(`passport for  ${passport.jobId ?? "?"}`);
} else {
  const data = new TextEncoder().encode(values.text ?? `KINETIC Swarm round trip ${new Date().toISOString()}`);
  // A batch is used when we sign stamps ourselves, or when the Bee node we upload to owns it.
  const ownBatch = cfg.swarm.postageBatchId && (cfg.swarm.stampKey || !isPublicGateway(cfg.swarm.beeUrl));
  const stamped = ownBatch ? `our batch ${cfg.swarm.postageBatchId}` : "the gateway's own batch (kept only for a while)";
  console.log(`uploading ${data.length} bytes to ${cfg.swarm.beeUrl}, stamped with ${stamped}`);
  const ref = await swarm.upload(data);
  console.log(`reference     ${ref}`);
  console.log(`              ${link(ref)}`);
  const back = await swarm.download(ref);
  const same = back.length === data.length && back.every((b, i) => b === data[i]);
  console.log(`read back     ${back.length} bytes, ${same ? "identical" : "DIFFERENT"}`);
  if (!same) process.exit(1);
}
