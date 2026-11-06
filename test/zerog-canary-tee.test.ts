import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadNetworkConfig } from "../src/config.js";
import { teeSignersOf, zeroGDirectory, type ZeroGDirectory, type ZeroGService } from "../src/integrations/zerog-compute.js";
import { checkCanarySigner, checkTeeSignature, parseSignedText, recheckCanaryTee, type CanaryTee } from "../src/integrations/zerog-tee.js";
import { NoProviderForTrustMode, ZeroGClient } from "../src/integrations/zerog.js";
import type { TaskSpec } from "../src/types.js";
import { sha256Hex } from "../src/util/crypto.js";
import { startDevnet, type Devnet } from "./support/devnet.js";

// Canary reference runs on the 0G router: TeeML only (`private`), never a silent downgrade, and
// the provider's TEE signature checked by the verifier itself against the signer registered in
// the 0G serving contract, not taken from the router's `tee_verified`.

const task: TaskSpec = { kind: "classify", instructions: "Classify the ticket.", labels: [{ name: "billing" }, { name: "bug" }] };
const items = [{ id: "t1", text: "I was charged twice" }];

async function client(port: number, env: Record<string, string> = {}) {
  const cfg = loadNetworkConfig({ KINETIC_NETWORK: "devnet", DEVNET_URL: `http://localhost:${port}`, ...env });
  return { cfg, zerog: new ZeroGClient(cfg.zerog, zeroGDirectory({ network: "devnet", zgCompute: { rpcUrl: cfg.zerog.teeRpcUrl } })) };
}

describe("canary reference runs: private trust mode, TEE signature verified by us", () => {
  let devnet: Devnet;
  let noTeeML: Devnet;
  let forged: Devnet;
  beforeAll(async () => {
    devnet = await startDevnet({ port: 4893 });
    noTeeML = await startDevnet({ port: 4894, routerNoTeeML: true });
    forged = await startDevnet({ port: 4895, routerBadTeeSignature: true });
  });
  afterAll(async () => {
    await Promise.all([devnet?.close(), noTeeML?.close(), forged?.close()]);
  });

  it("runs TeeML-only and records a signature that recovers to the on-chain signer", async () => {
    const { cfg, zerog } = await client(4893);
    expect(cfg.zerog.canaryTrustMode).toBe("private");
    const run = await zerog.reference(task, items);
    expect(run.trustMode).toBe("private");
    const tee = run.tee!;
    expect(tee).toMatchObject({ trustMode: "private", guarantee: "TeeML", providerType: "decentralized", verification: "verified", scheme: "zg-sig-v1/e2ee-ct", costUsdMicro: 25 });
    expect(tee.fallback).toBeUndefined();
    expect(tee.signedTextHash).toBe(sha256Hex(tee.signedText!));
    expect(tee.provider).toBe(run.provider.toLowerCase());
    expect(await recheckCanaryTee(tee)).toEqual({ ok: true });
    const directory = zeroGDirectory({ network: "devnet", zgCompute: { rpcUrl: cfg.zerog.teeRpcUrl } });
    expect(await checkCanarySigner(directory, tee)).toEqual({ ok: true });
    // Re-checked offline, an edit to anything signed shows.
    const other = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    expect((await recheckCanaryTee({ ...tee, signer: other }))?.ok).toBe(false);
    const text = tee.signedText!.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    expect((await recheckCanaryTee({ ...tee, signedText: text, signedTextHash: sha256Hex(text) }))?.ok).toBe(false);
    expect((await recheckCanaryTee({ ...tee, verification: "unavailable" }))?.ok).toBe(false);
    expect(await checkCanarySigner(directory, { ...tee, signer: other })).toMatchObject({ ok: false });
  });

  it("falls back to verified only with a note, and checks the relay's routing proof", async () => {
    const { zerog } = await client(4894);
    const run = await zerog.reference(task, items);
    expect(run.trustMode).toBe("verified");
    expect(run.tee).toMatchObject({ trustMode: "verified", guarantee: "TeeTLS", providerType: "centralized", verification: "verified" });
    expect(run.tee!.fallback).toMatch(/no private provider/);
    expect(run.tee!.routingProof).toBeDefined();
    expect(await recheckCanaryTee(run.tee!)).toEqual({ ok: true });
    // A sealed signature from a relay without its routing proof is not verified.
    const { routingProof: _, ...stripped } = run.tee!;
    expect((await checkTeeSignature(stripped as Required<CanaryTee>, "centralized")).ok).toBe(false);
  });

  it("never downgrades when the fallback is off", async () => {
    const { zerog } = await client(4894, { ZEROG_CANARY_FALLBACK: "none" });
    await expect(zerog.reference(task, items)).rejects.toBeInstanceOf(NoProviderForTrustMode);
  });

  it("refuses a reference whose TEE signature doesn't recover to the registered signer", async () => {
    const { zerog } = await client(4895);
    await expect(zerog.reference(task, items)).rejects.toThrow(/TEE signature is invalid/);
  });

  it("accepts the service's own signer when its LLM runs in a separate enclave", async () => {
    // As registered live on glm-5.3 (2026-11-05): TargetSeparated, decentralized, a target enclave
    // address, and the sealed router exchange signed by teeSignerAddress.
    const service = privateKeyToAccount(generatePrivateKey());
    const target = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const svc: ZeroGService = {
      provider: privateKeyToAccount(generatePrivateKey()).address.toLowerCase(),
      serviceType: "chatbot",
      url: "https://tee.example",
      model: "glm-5.3",
      verifiability: "TeeML",
      teeSignerAddress: service.address,
      teeSignerAcknowledged: true,
      additionalInfo: JSON.stringify({ TargetSeparated: true, TargetTeeAddress: target }),
    };
    expect(teeSignersOf(svc)).toEqual([target, service.address.toLowerCase()]);
    const directory: ZeroGDirectory = { list: async () => [svc], get: async (p) => (p === svc.provider ? svc : undefined) };
    const h = "b".repeat(64);
    const signedText = `zg-sig-v1/e2ee-ct:${h}:${h}`;
    const tee = { provider: svc.provider, signer: service.address.toLowerCase(), signedText, signedTextHash: sha256Hex(signedText), signature: await service.signMessage({ message: signedText }) } as CanaryTee;
    expect((await checkTeeSignature(tee as Required<CanaryTee>, "decentralized")).ok).toBe(true);
    expect(await checkCanarySigner(directory, tee)).toEqual({ ok: true });
    expect(await checkCanarySigner(directory, { ...tee, signer: target })).toEqual({ ok: true });
    expect((await checkCanarySigner(directory, { ...tee, signer: privateKeyToAccount(generatePrivateKey()).address })).ok).toBe(false);
  });

  it("reads the signed text's scheme and halves", () => {
    const h = "a".repeat(64);
    expect(parseSignedText(`zg-sig-v1/e2ee-ct:${h}:${h}`)).toMatchObject({ scheme: "zg-sig-v1/e2ee-ct", req: h, resp: h });
    expect(parseSignedText(`${h}:${h}`)).toMatchObject({ scheme: "legacy" });
    expect(parseSignedText(`zg-sig-v9/new:${h}:${h}`)).toHaveProperty("error");
  });
});
