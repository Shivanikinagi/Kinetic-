import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { loadNetworkConfig } from "../src/config.js";
import { ensureDevnetFunds, startDevnet, type Devnet } from "./support/devnet.js";
import { connect, type Services } from "../src/integrations/index.js";
import { HeuristicBackend } from "./support/heuristic.js";
import { ProviderSlashedError, startProvider, type RunningProvider } from "../src/provider/node.js";

const PORT = 4830;
let devnet: Devnet;
let svc: Services;
let provider: RunningProvider;

beforeAll(async () => {
  devnet = await startDevnet({ port: PORT });
  svc = connect(loadNetworkConfig({ KINETIC_NETWORK: "devnet", DEVNET_URL: devnet.url }), { privateKey: generatePrivateKey() });
  await ensureDevnetFunds(svc);
  provider = await startProvider(
    { name: "relisted", port: PORT + 2, gpu: "test", tasks: ["classify"], priceTinybar: 1000n, bondTinybar: 10_000n, backend: new HeuristicBackend(), behavior: { kind: "honest" }, heartbeatMs: 150 },
    svc,
  );
}, 30_000);

afterAll(async () => {
  await provider?.close();
  await devnet?.close();
});

describe("provider offer", () => {
  it("is republished when it expired between heartbeats", async () => {
    const first = provider.offerKey;
    // Simulate a missed renewal: the entity is gone from Arkiv.
    await svc.arkiv.remove(first);
    await new Promise((r) => setTimeout(r, 900));
    const offers = await svc.arkiv.query("offer", { provider: svc.address });
    expect(offers).toHaveLength(1);
    expect(offers[0].key).not.toBe(first);
    expect(provider.offerKey).toBe(offers[0].key);
  });
});

describe("a slashed provider", () => {
  it("refuses to start: the vault won't take a new bond and no buyer would use it", async () => {
    const { signDigest, verdictDigest, quorumSignatures } = await import("../src/core/verdict.js");
    const { DEVNET_VAULT } = await import("./support/devnet.js");
    const verifier = connect(loadNetworkConfig({ KINETIC_NETWORK: "devnet", DEVNET_URL: devnet.url }), { privateKey: generatePrivateKey() });
    devnet.setVerifiers([verifier.address], 1, 1);
    const v = { provider: svc.address, buyer: verifier.address, jobId: "job-x", chunk: 0, resultHash: "00".repeat(32), refundTinybar: 1n, evidence: "{}" };
    const digest = verdictDigest(v, DEVNET_VAULT);
    const q = await quorumSignatures(digest, [await signDigest(verifier.account, digest)], [verifier.address]);
    const { slashId } = await verifier.vault.proposeSlash(v, q.signatures);
    await verifier.vault.executeSlash(slashId);
    expect((await svc.vault.bondOf(svc.address)).slashed).toBe(true);
    await expect(svc.vault.postBond(1n)).rejects.toThrow(/ProviderSlashed/);
    const before = (await svc.arkiv.query("offer", { provider: svc.address })).length;
    await expect(
      startProvider({ name: "slashed", port: PORT + 3, gpu: "test", tasks: ["classify"], priceTinybar: 1000n, bondTinybar: 10_000n, backend: new HeuristicBackend(), behavior: { kind: "honest" } }, svc),
    ).rejects.toBeInstanceOf(ProviderSlashedError);
    expect((await svc.arkiv.query("offer", { provider: svc.address })).length).toBe(before);
    expect((await svc.vault.bondOf(svc.address)).amountTinybar).toBe(0n);
  });
});
