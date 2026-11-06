import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spreadUpstreams } from "../src/agent/buyer.js";
import { verifyPassport, type Passport } from "../src/agent/passport.js";
import { loadNetworkConfig } from "../src/config.js";
import { readReceipts, type ReceiptLog } from "../src/integrations/hcs.js";
import { connect } from "../src/integrations/index.js";
import { attest, UpstreamError, ZeroGComputeBackend, zeroGComputeClient, zeroGDirectory } from "../src/integrations/zerog-compute.js";
import type { Offer, TaskSpec } from "../src/types.js";
import { Verifier } from "../src/verifier/verifier.js";
import { startDevnet, type Devnet } from "./support/devnet.js";
import { runScenario, type Scenario } from "./support/scenario.js";

// Providers that call individual 0G Compute providers directly (not the 0G router): every
// result names the 0G provider that ran it, the verifier checks that provider's TEE
// attestation itself and binds it to the exact response the result came from, and a chunk
// that fails on one 0G provider goes to a different one.

const task: TaskSpec = { kind: "classify", instructions: "Classify the ticket.", labels: [{ name: "billing" }, { name: "bug" }] };
const items = [{ id: "t1", text: "I was charged twice" }];

describe("0G Compute attestation", () => {
  let devnet: Devnet;
  const PORT = 4890;
  beforeAll(async () => {
    devnet = await startDevnet({ port: PORT, zgProviders: [{ model: "m-a" }, { model: "m-b", verifiability: "" }, { model: "m-c", relays: "aliyun" }] });
  });
  afterAll(async () => {
    await devnet?.close();
  });
  const cfg = () => loadNetworkConfig({ KINETIC_NETWORK: "devnet", DEVNET_URL: `http://localhost:${PORT}` });
  const run = async (i: number) => (await new ZeroGComputeBackend(zeroGComputeClient(cfg()), devnet.zgProviders[i]).init()).runWithEvidence(task, items);
  const service = async (i: number) => (await zeroGDirectory(cfg()).get(devnet.zgProviders[i]))!;

  it("records which 0G provider ran a chunk; its TEE attests the exact response the result came from", async () => {
    const out = await run(0);
    expect(out.result.items).toHaveLength(1);
    expect(out.execution).toMatchObject({ zgProvider: devnet.zgProviders[0], model: "m-a", verifiability: "TeeML", providerType: "decentralized", attestation: "verified" });
    expect(await attest(await service(0), out.execution.chatId, out.execution.responseHash)).toMatchObject({ attestation: "verified" });
  });

  it("calls an attestation invalid when the signature is missing, wrong, or covers another response", async () => {
    const svc = await service(0);
    expect((await attest(svc, "chatcmpl-made-up", "00", { retries: 0 })).attestation).toBe("invalid");
    const { execution } = await run(0);
    expect((await attest({ ...svc, teeSignerAddress: "0x000000000000000000000000000000000000dEaD" }, execution.chatId, execution.responseHash)).attestation).toBe("invalid");
    expect(await attest(svc, execution.chatId, "f".repeat(64))).toMatchObject({ attestation: "invalid", reason: expect.stringMatching(/different response/) });
  });

  it("never calls a valid signature verified without the response it covers", async () => {
    const { execution } = await run(0);
    expect((await attest(await service(0), execution.chatId)).attestation).toBe("unavailable");
  });

  it("reports unavailable, not verified, for a service without verifiability", async () => {
    expect((await run(1)).execution.attestation).toBe("unavailable");
  });

  it("names a centralized 0G provider as a relay to an outside cloud", async () => {
    expect((await run(2)).execution).toMatchObject({ providerType: "centralized", providerIdentity: "aliyun", attestation: "verified" });
  });

  it("fails with an UpstreamError when its 0G provider is down", async () => {
    devnet.setZgDown(devnet.zgProviders[0], true);
    try {
      await expect(run(0)).rejects.toBeInstanceOf(UpstreamError);
    } finally {
      devnet.setZgDown(devnet.zgProviders[0], false);
    }
  });

  it("keeps used chat ids across a verifier restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "kinetic-chats-"));
    try {
      const svc = connect({ ...cfg(), stateDir: dir }, { privateKey: generatePrivateKey() });
      const receipts = { topicId: "0.0.1", submit: async () => ({ sequence: 1 }) } as ReceiptLog;
      const first = new Verifier(svc, svc.zerog(), receipts) as unknown as { useChat(k: string): void; seenChats: Map<string, number> };
      first.useChat("0xabc|chatcmpl-1");
      const second = new Verifier(svc, svc.zerog(), receipts) as unknown as { seenChats: Map<string, number> };
      expect(second.seenChats.has("0xabc|chatcmpl-1")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("choosing 0G providers", () => {
  const offer = (name: string, zgProvider?: string, attestable?: boolean) => ({ name, zgProvider, attestable }) as Offer;
  it("puts the best offer on each 0G provider first; a second one on the same 0G provider waits", () => {
    const ranked = [offer("a", "0x1"), offer("b", "0x1"), offer("c", "0x2"), offer("d"), offer("e", "0x2")];
    expect(spreadUpstreams(ranked).map((o) => o.name)).toEqual(["a", "c", "d", "b", "e"]);
  });
  it("prefers 0G providers whose responses can be attested", () => {
    const ranked = [offer("cheap", "0x1", false), offer("attested", "0x2", true), offer("other", "0x3", false)];
    expect(spreadUpstreams(ranked).map((o) => o.name)).toEqual(["attested", "cheap", "other"]);
  });
});

describe("rerouting when a 0G provider fails mid-job", () => {
  let s: Scenario;
  let zgA: string;
  beforeAll(async () => {
    // atlas (and flicker) run on the first 0G provider, which serves 4 chats and then goes
    // down for good: the admission probes take 2, so it dies two chunks into the job.
    s = await runScenario({ basePort: 8100, chunkSize: 2, canaryRate: 0.5, zeroG: { zgProviders: [{ model: "devnet-0gm", failAfter: 4 }, { model: "devnet-qwen" }, { model: "devnet-gemma" }] } });
    zgA = s.devnet.zgProviders[0];
  }, 90_000);
  afterAll(async () => {
    await s?.close();
  });

  it("finishes the job on the other, independent 0G providers", () => {
    expect(s.report.status).toBe("complete");
    expect(s.devnet.zgServed(zgA)).toBe(4);
    const atlas = s.report.providers.find((p) => p.name === "atlas-4090")!;
    expect(atlas).toMatchObject({ zgProvider: zgA, attestable: true, providerType: "decentralized", status: "offline" });
  });

  it("names the 0G provider behind every chunk, attested by the verifier", async () => {
    const passport = (await (await fetch(s.report.passport.url)).json()) as Passport;
    expect(passport.work.length).toBe(s.report.chunks);
    for (const w of passport.work) {
      expect(s.devnet.zgProviders).toContain(w.execution?.zgProvider);
      expect(w.attestation).toBe("verified");
    }
    // At most the two job chunks it served before going down.
    expect(passport.work.filter((w) => w.execution!.zgProvider === zgA).length).toBeLessThanOrEqual(2);
    expect(new Set(passport.work.map((w) => w.execution!.zgProvider)).size).toBeGreaterThanOrEqual(2);
    const checks = await verifyPassport(passport);
    expect(checks.filter((c) => c.ok === false)).toEqual([]);
    expect(checks.find((c) => c.name === "every 0G chunk is TEE-verified")?.ok).toBe(true);
    // Canaries: each reference run was TeeML-only, its TEE signature checked by the verifier and re-checked here.
    expect(passport.canaries.checked.length).toBeGreaterThan(0);
    for (const c of passport.canaries.checked) expect(c.tee).toMatchObject({ trustMode: "private", guarantee: "TeeML", verification: "verified" });
    expect(checks.find((c) => c.name === "canary TEE signatures re-verified")?.ok).toBe(true);
    expect(checks.find((c) => c.name === "every canary ran TeeML-only (private) with a verified TEE signature")?.ok).toBe(true);
    // A forged canary signature is caught offline (the passport's own signatures aside).
    const forged = structuredClone(passport);
    forged.canaries.checked[0]!.tee!.signer = "0x000000000000000000000000000000000000dead";
    const again = await verifyPassport(forged);
    expect(again.find((c) => c.name === "canary TEE signatures re-verified")?.ok).toBe(false);
  });

  it("puts the 0G provider, model, chat id and attestation of each chunk on HCS", async () => {
    const receipts = (await readReceipts(s.buyerSvc.cfg.hedera, 1000)).map((m) => m.receipt);
    const chunks = receipts.filter((r) => r.t === "chunk" && r.job === s.report.jobId);
    expect(chunks.length).toBeGreaterThanOrEqual(s.report.chunks);
    for (const r of chunks) if (r.t === "chunk" && r.zg) expect(r).toMatchObject({ chat: expect.any(String), m: expect.any(String), pt: "decentralized" });
    expect(chunks.filter((r) => r.t === "chunk" && r.att === "verified").length).toBeGreaterThanOrEqual(s.report.chunks);
  });

  it("slashes a provider that declares a 0G provider but stops calling it", () => {
    // cheapo degrades after one chunk: its results carry no 0G execution record, which the
    // verifier counts as a failed check on every chunk, not only on canaries.
    const cheapo = s.report.providers.find((p) => p.name === "cheapo-3060")!;
    expect(cheapo.status).toBe("slashed");
    expect(cheapo.kept).toBe(0);
    expect(cheapo.refundTinybar).toBe(cheapo.paidTinybar);
  });
});

describe("a provider that changes the 0G answer before returning it", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await runScenario({ basePort: 8300, chunkSize: 2, canaryRate: 0.5, zeroG: { tamper: ["nimbus-a100"] } });
  }, 90_000);
  afterAll(async () => {
    await s?.close();
  });

  it("is caught on its first chunk, though its 0G call and TEE signature are real", async () => {
    const nimbus = s.report.providers.find((p) => p.name === "nimbus-a100")!;
    expect(nimbus.kept).toBe(0);
    const receipts = (await readReceipts(s.buyerSvc.cfg.hedera, 1000)).map((m) => m.receipt);
    const mine = receipts.filter((r) => r.t === "chunk" && r.job === s.report.jobId && r.provider === nimbus.provider);
    expect(mine.length).toBeGreaterThan(0);
    for (const r of mine) expect(r).toMatchObject({ att: "invalid", why: expect.stringMatching(/result differs/) });
    expect(s.report.status).toBe("complete");
  });
});
