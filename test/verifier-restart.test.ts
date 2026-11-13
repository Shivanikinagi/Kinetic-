import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { loadJob } from "../src/agent/report.js";
import { verifyReveal } from "../src/core/canary.js";
import { loadNetworkConfig } from "../src/config.js";
import { startDevnet, type Devnet } from "./support/devnet.js";
import { connect, type Services } from "../src/integrations/index.js";
import { deriveKey, encryptJson, randomKey, toBase64 } from "../src/util/crypto.js";
import { Verifier, type JobRegistration } from "../src/verifier/verifier.js";

// A verifier that restarts mid-job must still know the job: its canary plan and salt (to
// reveal what it committed to on HCS), its payments and its fee.

const PORT = 4850;
let devnet: Devnet;
let svc: Services;
let stateDir: string;
const buyer = "0x00000000000000000000000000000000000000b1";

beforeAll(async () => {
  devnet = await startDevnet({ port: PORT });
  stateDir = mkdtempSync(join(tmpdir(), "kinetic-verifier-"));
  svc = connect(loadNetworkConfig({ KINETIC_NETWORK: "devnet", DEVNET_URL: devnet.url, KINETIC_STATE_DIR: stateDir, CANARY_RATE: "0.5" }), { privateKey: generatePrivateKey() });
});

afterAll(async () => {
  await devnet.close();
});

async function registration(jobId: string): Promise<JobRegistration> {
  const { task, items } = loadJob("data/classify-tickets.task.json", "data/tickets.jsonl");
  const jobKey = randomKey();
  const parts = [items.slice(0, 2), items.slice(2, 4)];
  const chunks = parts.map((part, idx) => ({ idx, data: toBase64(encryptJson(deriveKey(jobKey, `chunk:${idx}`), part)), itemIds: part.map((i) => i.id) }));
  return { jobId, buyer, task, chunks, jobKey: toBase64(jobKey) };
}

const start = () => new Verifier(svc, svc.zerog(), svc.receipts());

describe("verifier restart", () => {
  it("finishes a job registered before the restart and reveals the committed canaries", async () => {
    const before = start();
    const { commitment } = await before.registerJob(await registration("job-restart-1"));
    before.recordFee("job-restart-1", 20_000n, "fee-tx-1");

    const after = start();
    const out = await after.finalize("job-restart-1", buyer);
    expect(out.commitment).toBe(commitment);
    expect(verifyReveal("job-restart-1", out.canaries, out.salt, commitment)).toBe(true);
    expect(out.fee).toEqual({ amountTinybar: 20_000n, tx: "fee-tx-1" });
    expect((await after.status()).earnings.feePayments).toBe(1);
  });

  it("forgets a dropped job for good", async () => {
    const v = start();
    await v.registerJob(await registration("job-restart-2"));
    v.dropJob("job-restart-2");
    await expect(start().finalize("job-restart-2", buyer)).rejects.toThrow(/unknown job/);
  });

  it("names saved files by a hash, never by the buyer's job id", async () => {
    await start().registerJob(await registration("../../escape"));
    const files = readdirSync(join(stateDir, `verifier-${svc.address}`, "jobs"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(f).toMatch(/^[0-9a-f]{32}\.json$/);
  });
});
