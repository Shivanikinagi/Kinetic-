import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { loadNetworkConfig } from "../src/config.js";
import { startDevnet, type Devnet } from "./support/devnet.js";
import { connect, type Services } from "../src/integrations/index.js";
import { BudgetExceededError, PaymentGate, PaymentInFlightError, payFetch, ReplayGuard } from "../src/integrations/x402.js";
import { createApp, listen } from "../src/util/http.js";
import type { Server } from "node:http";

const PORT = 4810;
let devnet: Devnet;
let server: Server;
let buyer: Services;
let seller: Services;
const url = `http://localhost:${PORT + 1}/paid`;

beforeAll(async () => {
  devnet = await startDevnet({ port: PORT });
  const cfg = loadNetworkConfig({ KINETIC_NETWORK: "devnet", DEVNET_URL: devnet.url });
  buyer = connect(cfg, { privateKey: generatePrivateKey() });
  seller = connect(cfg, { privateKey: generatePrivateKey() });
  devnet.fund(buyer.address, 1_000_000n);

  const gate = new PaymentGate({ network: cfg.x402.network, facilitatorUrl: cfg.x402.facilitatorUrl, asset: "0.0.0", payTo: seller.payTo, amount: 1000n, description: "test" });
  let fail = false;
  const app = createApp();
  app.post("/paid", (req, res) => {
    fail = req.body.fail === true;
    void gate.handle(req, res, async () => {
      if (fail) throw new Error("boom");
      return { ok: true };
    });
  });
  // Settles, then drops the connection before answering: a provider dying mid-request.
  const dropGate = new PaymentGate({
    network: cfg.x402.network,
    facilitatorUrl: cfg.x402.facilitatorUrl,
    asset: "0.0.0",
    payTo: seller.payTo,
    amount: 1000n,
    description: "drops",
    onSettled: () => dropNext?.(),
  });
  let dropNext: (() => void) | undefined;
  app.post("/drops", (req, res) => {
    dropNext = () => req.socket.destroy();
    void dropGate.handle(req, res, async () => ({ ok: true }));
  });
  server = await listen(app, PORT + 1);
});

afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await devnet.close();
});

const post = (body: object, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("x402 payment gate", () => {
  it("quotes with HTTP 402 and a PAYMENT-REQUIRED header", async () => {
    const res = await fetch(url, post({}));
    expect(res.status).toBe(402);
    expect(res.headers.get("payment-required")).toBeTruthy();
    const body = await res.json();
    expect(body.accepts[0]).toMatchObject({ scheme: "exact", network: "kinetic:devnet", amount: "1000", payTo: seller.payTo });
  });

  it("settles a paid request and moves the funds", async () => {
    const before = devnet.balanceOf(buyer.address);
    const { response, settlement } = await payFetch(url, post({}), buyer.payer(), 5000n);
    expect(response.status).toBe(200);
    expect(settlement?.success).toBe(true);
    expect(devnet.balanceOf(buyer.address)).toBe(before - 1000n);
    expect(devnet.balanceOf(seller.address)).toBe(1000n);
  });

  it("does not charge when the work fails", async () => {
    const before = devnet.balanceOf(buyer.address);
    const { response } = await payFetch(url, post({ fail: true }), buyer.payer(), 5000n);
    expect(response.status).toBe(500);
    expect(devnet.balanceOf(buyer.address)).toBe(before);
  });

  it("refuses quotes above the agent's limit", async () => {
    await expect(payFetch(url, post({}), buyer.payer(), 999n)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("lets the payer find out a payment settled even when the response was lost", async () => {
    const before = devnet.balanceOf(buyer.address);
    const signer = buyer.payer();
    const err = await payFetch(`http://localhost:${PORT + 1}/drops`, post({}), signer, 5000n).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentInFlightError);
    expect(await signer.isSettled((err as PaymentInFlightError).paymentId)).toBe(true);
    expect(devnet.balanceOf(buyer.address)).toBe(before - 1000n);
    expect(await signer.isSettled("0".repeat(32))).toBe(false);
  });

  it("rejects a replayed payment header", async () => {
    const first = await fetch(url, post({}));
    const required = await first.json();
    const payload = { x402Version: 2, resource: required.resource, accepted: required.accepts[0], payload: await buyer.payer().createPayload(required.accepts[0]) };
    const { encodePaymentSignatureHeader } = await import("@x402/core/http");
    const header = { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) };
    expect((await fetch(url, post({}, header))).status).toBe(200);
    expect((await fetch(url, post({}, header))).status).toBe(402);
  });

  it("keeps rejecting a used header after the node restarts", async () => {
    const cfg = loadNetworkConfig({ KINETIC_NETWORK: "devnet", DEVNET_URL: devnet.url });
    const file = join(mkdtempSync(join(tmpdir(), "kinetic-replay-")), "replay.json");
    const start = () =>
      new PaymentGate({ network: cfg.x402.network, facilitatorUrl: cfg.x402.facilitatorUrl, asset: "0.0.0", payTo: seller.payTo, amount: 1000n, description: "restarts", replay: new ReplayGuard(file) });
    let gate = start();
    const app = createApp();
    app.post("/restarts", (req, res) => void gate.handle(req, res, async () => ({ ok: true })));
    const restarting = await listen(app, PORT + 2);
    try {
      const target = `http://localhost:${PORT + 2}/restarts`;
      const required = await (await fetch(target, post({}))).json();
      const payload = { x402Version: 2, resource: required.resource, accepted: required.accepts[0], payload: await buyer.payer().createPayload(required.accepts[0]) };
      const { encodePaymentSignatureHeader } = await import("@x402/core/http");
      const header = { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) };
      expect((await fetch(target, post({}, header))).status).toBe(200);
      gate = start(); // a fresh gate over the same file, as after a restart
      const replayed = await fetch(target, post({}, header));
      expect(replayed.status).toBe(402);
      // Caught by the gate itself, before the facilitator or the work.
      expect((await replayed.json()).error).toBe("payment already used");
    } finally {
      restarting.closeAllConnections();
      restarting.close();
    }
  });
});

describe("arkiv devnet store", () => {
  it("enforces ownership and filters by attributes", async () => {
    const key = await seller.arkiv.create({ kind: "offer", attrs: { provider: seller.address, price: 5 }, ttlSeconds: 60 });
    const found = await buyer.arkiv.query("offer", { provider: seller.address });
    expect(found.map((e) => e.key)).toEqual([key]);
    expect(found[0].attrs.price).toBe(5n);
    expect(await buyer.arkiv.query("offer", { price: 6 })).toHaveLength(0);
    await expect(buyer.arkiv.patch(key, { price: 1 })).rejects.toThrow(/owner/);
    await seller.arkiv.patch(key, { price: 7 });
    expect((await seller.arkiv.query("offer", { price: 7 }))[0].key).toBe(key);
  });

  it("drops entities once they expire", async () => {
    await seller.arkiv.create({ kind: "claim", attrs: { job_id: "short" }, ttlSeconds: 1 });
    expect(await seller.arkiv.query("claim", { job_id: "short" })).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 1100));
    expect(await seller.arkiv.query("claim", { job_id: "short" })).toHaveLength(0);
  });
});
