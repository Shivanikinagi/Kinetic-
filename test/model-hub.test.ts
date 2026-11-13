import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPassport, type Passport } from "../src/agent/passport.js";
import { readReceipts } from "../src/integrations/hcs.js";
import { payFetch } from "../src/integrations/x402.js";
import { MODEL_CARD_KIND, signCard, type ModelCard } from "../src/models/card.js";
import { modelPassportDigest, verifyModelPassport, type ModelPassport } from "../src/models/passport.js";
import { findModels } from "../src/models/registry.js";
import { waitForReview } from "../src/models/publish.js";
import { sha256Hex } from "../src/util/crypto.js";
import { signedRequest } from "../src/util/sign.js";
import { runScenario, tinyModelFiles, type Scenario } from "./support/scenario.js";

// The model hub end to end on the devnet: a creator publishes a model with safetensors weights,
// a quorum of verifiers reviews it and signs its Model Passport, providers check the passport
// and the weights before they serve it, and a buyer runs a job on that model. The usual cheaters
// are there too: one is slashed mid-job, and its chunks must earn the creator nothing.

let s: Scenario;

beforeAll(async () => {
  s = await runScenario({ basePort: 15100, chunkSize: 2, canaryRate: 0.6, quorum: { cosigners: 2, threshold: 2 }, modelHub: { royaltyBps: 500, serve: ["atlas-4090", "nimbus-a100", "cheapo-3060", "shoddy-1060"] } });
}, 120_000);

afterAll(async () => {
  await s?.close();
});

describe("model hub on devnet", () => {
  it("lists the model with a Model Passport signed by a quorum of the vault's verifiers", async () => {
    const { published, listing } = s.hub!;
    expect(listing.key).toBe(published.key);
    // The lead and both cosigners re-ran the checks and signed.
    expect(published.signers).toHaveLength(3);
    const passport = (await (await fetch(s.buyerSvc.storage.url(published.passportRef))).json()) as ModelPassport;
    const info = await s.buyerSvc.vault.info();
    const checks = await verifyModelPassport(passport, { verifiers: info.verifiers, threshold: info.threshold });
    expect(checks.filter((c) => c.ok === false)).toEqual([]);
    expect(passport.weights).toMatchObject({ checked: true, ok: true, params: 15 });
    expect(passport.benchmark.accuracy).toBeGreaterThanOrEqual(passport.benchmark.minAccuracy);
    expect(Object.keys(passport.fingerprint?.answers ?? {}).length).toBeGreaterThanOrEqual(3);
  });

  it("keeps the weights on 0G Storage, addressed by root hash", () => {
    const files = s.hub!.listing.card.weights!.files;
    expect(files.every((f) => /^0x[0-9a-f]{64}$/.test(f.zgRoot ?? ""))).toBe(true);
  });

  it("logs the passport on HCS and keeps the listing on Arkiv", async () => {
    const receipts = await readReceipts({ mirrorUrl: `${s.devnet.url}/mirror`, hcsTopicId: s.buyerSvc.cfg.hedera.hcsTopicId, jsonRpcUrl: "" }, 1000);
    const model = receipts.map((m) => m.receipt).find((r) => r.t === "model");
    expect(model).toMatchObject({ model: s.hub!.published.key, digest: s.hub!.published.passportDigest, royaltyBps: 500 });
    const listed = await findModels(s.buyerSvc.arkiv, (await s.buyerSvc.vault.info()).verifiers);
    expect(listed.map((l) => l.key)).toContain(s.hub!.published.key);
  });

  it("stores the Model Passport on 0G Storage, served by its root over HTTP", async () => {
    const listed = (await findModels(s.buyerSvc.arkiv, (await s.buyerSvc.vault.info()).verifiers)).find((l) => l.key === s.hub!.published.key)!;
    expect(listed.passportRef).toMatch(/^0x[0-9a-f]{64}$/);
    // The indexer's /file?root= link, as the dashboard and verify-passport fetch it.
    const served = (await (await fetch(s.buyerSvc.storage.url(listed.passportRef))).json()) as ModelPassport;
    expect(modelPassportDigest(served)).toBe(listed.passportDigest);
    expect(served.references.storageGateway).toBe(s.buyerSvc.storage.gateway);
    // And through the verifier, which checks the bytes against the root.
    const proxied = (await (await fetch(`${s.verifierUrl}/passports/${listed.passportRef}`)).json()) as ModelPassport;
    expect(modelPassportDigest(proxied)).toBe(listed.passportDigest);
  });

  it("runs the job only on providers that serve the model, every chunk signed for it", () => {
    expect(s.report.status).toBe("complete");
    const names = s.report.providers.map((p) => p.name).sort();
    expect(names).not.toContain("flicker-t4");
    expect(s.report.model).toMatchObject({ key: s.hub!.published.key, royaltyBps: 500 });
  });

  it("still slashes a cheater and keeps a lazy provider out on a model job", () => {
    const by = Object.fromEntries(s.report.providers.map((p) => [p.name, p]));
    expect(by["cheapo-3060"].status).toBe("slashed");
    expect(by["cheapo-3060"].kept).toBe(0);
    expect(by["shoddy-1060"].status).toBe("unqualified");
  });

  it("pays the creator exactly its share of the accepted chunks, and nothing for slashed work", () => {
    const passport = s.report;
    const kept = s.report.providers.reduce((a, p) => a + p.kept, 0);
    expect(kept).toBe(s.report.chunks);
    expect(s.report.royaltyTinybar).toBeGreaterThan(0n);
    expect(s.balances.creatorAfter! - s.balances.creatorBefore!).toBe(s.report.royaltyTinybar);
    expect(BigInt(passport.model!.royalty!.amount)).toBe(s.report.royaltyTinybar);
    // The buyer pays the providers, the verifier's fee and the royalty, less refunds.
    const net = s.report.paidTinybar - s.report.refundedTinybar + s.report.verificationFeeTinybar + s.report.royaltyTinybar!;
    expect(s.balances.buyerBefore - s.balances.buyerAfter).toBe(net);
  });

  it("publishes a Compute Passport that ties the job to the model and passes every check", async () => {
    const passport = (await (await fetch(s.report.passport.url)).json()) as Passport;
    expect(passport.model?.key).toBe(s.hub!.published.key);
    expect(passport.agreement.model?.royaltyBps).toBe(500);
    const checks = await verifyPassport(passport, { results: s.report.results, online: true });
    expect(checks.filter((c) => c.ok === false)).toEqual([]);
    const names = checks.filter((c) => c.ok === true).map((c) => c.name);
    expect(names).toContain("creator royalty is the agreed share of the accepted chunks");
    expect(names).toContain("mirror node: the royalty reached the creator");
    expect(names).toContain("0G Storage: the Model Passport is the one the job ran against");
  });

  it("refuses a provider request for a model it doesn't serve, before any payment", async () => {
    const flicker = s.providers.find((p) => p.name === "flicker-t4")!;
    const res = await fetch(`${flicker.url}/v1/chunks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: "job-x", idx: 0, task: { kind: "classify", instructions: "x" }, data: "A".repeat(44), chunkKey: "a".repeat(44), model: s.hub!.published.key }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "model_not_served" });
  });

  it("refuses pickle weights, unsigned cards and a version that is already listed", async () => {
    const creator = s.hub!.creator;
    const draft = s.hub!.listing.card;
    // Quick checks refuse before any payment; the full review refuses afterwards, reported on its review.
    const post = async (card: ModelCard, signature: string) => {
      const paid = await payFetch(`${s.verifierUrl}/models`, await signedRequest(creator.account, { card, signature }), creator.payer(), 10_000_000n);
      const body = (await paid.response.json()) as { key?: string; reasons?: string[] };
      if (!paid.response.ok || !body.key) return { status: paid.response.status, paid: false, body };
      const review = await waitForReview(s.verifierUrl, body.key, 60_000, 200);
      return { status: review.status === "listed" ? 200 : 400, paid: !!paid.settlement?.success, body: { reasons: review.reasons } };
    };
    // A pickle file: uploaded straight to 0G Storage, so only the verifier's own checks can stop it.
    const pickle = new TextEncoder().encode("cos\nsystem\n(S'echo pwned'\ntR.");
    const { root } = await creator.zgStorage!().upload(pickle);
    const bad: ModelCard = { ...draft, kind: MODEL_CARD_KIND, version: "1.0.1", weights: { format: "safetensors", files: [{ name: "pytorch_model.bin", sha256: sha256Hex(pickle), bytes: pickle.length, zgRoot: root }] } };
    const refused = await post(bad, await signCard(creator.account, bad));
    expect(refused.status).toBe(400);
    expect(refused.paid).toBe(true);
    expect(refused.body.reasons?.join(" ")).toMatch(/malware check/);

    const files = tinyModelFiles();
    const forged: ModelCard = { ...draft, version: "1.0.2" };
    const forgedOut = await post(forged, await signCard(s.buyerSvc.account, forged));
    expect(forgedOut.paid).toBe(false);
    expect(forgedOut.body.reasons?.join(" ")).toMatch(/signed by its creator/);

    expect(files.length).toBe(2);
    // Someone else re-listing the creator's weights under their own card, to take the royalties.
    const thief = s.buyerSvc;
    const stolen: ModelCard = { ...draft, id: "thief/ticket-classifier", creator: { address: thief.address, payTo: thief.payTo } };
    const paidThief = await payFetch(`${s.verifierUrl}/models`, await signedRequest(thief.account, { card: stolen, signature: await signCard(thief.account, stolen) }), thief.payer(), 10_000_000n);
    expect(paidThief.response.status).toBe(400);
    expect(((await paidThief.response.json()) as { reasons?: string[] }).reasons?.join(" ")).toMatch(/already listed as kinetic\/ticket-classifier@1\.0\.0 by another creator/);

    const again = await post(draft, await signCard(creator.account, draft));
    expect(again.paid).toBe(false);
    expect(again.body.reasons?.join(" ")).toMatch(/already listed/);
  });
});
