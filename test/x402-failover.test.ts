import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { loadNetworkConfig, TESTNET_FACILITATORS } from "../src/config.js";
import { FacilitatorPool, PaymentGate } from "../src/integrations/x402.js";
import { createApp, listen } from "../src/util/http.js";

// x402 facilitator failover: quotes come from the first healthy facilitator, and a payment is
// verified and settled by the facilitator that quoted it (it is signed for that one's fee payer).

const BASE = 17400;
const NETWORK = "hedera:testnet";

interface Fake {
  url: string;
  feePayer: string;
  /** HTTP status /supported, /verify and /settle answer with while down. */
  down?: number;
  calls: { supported: number; verify: number; settle: number };
}

const fakes: Fake[] = [];
const servers: Server[] = [];

async function fake(port: number, feePayer: string): Promise<Fake> {
  const f: Fake = { url: `http://localhost:${port}`, feePayer, calls: { supported: 0, verify: 0, settle: 0 } };
  const app = createApp();
  app.get("/supported", (_req, res) => {
    f.calls.supported++;
    if (f.down) return void res.status(f.down).send("down");
    res.json({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK, extra: { feePayer } }], extensions: [], signers: {} });
  });
  app.post("/verify", (req, res) => {
    f.calls.verify++;
    if (f.down) return void res.status(f.down).send("down");
    const ok = req.body.paymentRequirements.extra.feePayer === feePayer;
    res.json(ok ? { isValid: true, payer: "0.0.42" } : { isValid: false, invalidReason: "signed for another fee payer" });
  });
  app.post("/settle", (_req, res) => {
    f.calls.settle++;
    if (f.down) return void res.status(f.down).send("down");
    res.json({ success: true, transaction: `0.0.42@1700000000.${f.calls.settle}`, network: NETWORK, payer: "0.0.42" });
  });
  servers.push(await listen(app, port));
  fakes.push(f);
  return f;
}

let a: Fake, b: Fake, c: Fake;
let gateUrl: string;
let gate: PaymentGate;

beforeAll(async () => {
  a = await fake(BASE, "0.0.1001");
  b = await fake(BASE + 1, "0.0.1002");
  c = await fake(BASE + 2, "0.0.1003");
  gate = new PaymentGate({ network: NETWORK, facilitatorUrl: a.url, facilitatorUrls: [a.url, b.url, c.url], asset: "0.0.0", payTo: "0.0.777", amount: 500n, description: "failover" });
  const app = createApp();
  app.post("/paid", (req, res) => void gate.handle(req, res, async () => ({ ok: true })));
  servers.push(await listen(app, BASE + 3));
  gateUrl = `http://localhost:${BASE + 3}/paid`;
});

afterAll(() => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
});

const pay = (requirements: PaymentRequirements) =>
  fetch(gateUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": encodePaymentSignatureHeader({ x402Version: 2, resource: { url: gateUrl, description: "", mimeType: "application/json" }, accepted: requirements, payload: { transaction: Math.random().toString(36) } }) },
    body: "{}",
  });

describe("x402 facilitator failover", () => {
  it("lists every testnet facilitator by default, X402_FACILITATOR_URL first; X402_FACILITATOR_URLS replaces the list", () => {
    expect(loadNetworkConfig({}).x402.facilitatorUrls).toEqual(TESTNET_FACILITATORS);
    const one = loadNetworkConfig({ X402_FACILITATOR_URL: "https://api.testnet.blocky402.com/" }).x402;
    expect(one.facilitatorUrl).toBe("https://api.testnet.blocky402.com");
    expect(one.facilitatorUrls).toEqual(["https://api.testnet.blocky402.com", "https://x402.org/facilitator", "https://testnet.facilitator.launa.dev"]);
    expect(loadNetworkConfig({ X402_FACILITATOR_URLS: "https://x/f, https://y/" }).x402.facilitatorUrls).toEqual(["https://x/f", "https://y"]);
  });

  it("refuses an EVM payee or a payment window over 180 s on Hedera", () => {
    expect(() => new PaymentGate({ network: NETWORK, facilitatorUrl: a.url, asset: "0.0.0", payTo: "0xabc", amount: 1n, description: "" })).toThrow(/0\.0\.x/);
    expect(() => new PaymentGate({ network: NETWORK, facilitatorUrl: a.url, asset: "0.0.0", payTo: "0.0.5", amount: 1n, description: "", maxTimeoutSeconds: 300 })).toThrow(/180/);
  });

  it("quotes from the first facilitator that answers /supported, and settles with the one that quoted", async () => {
    a.down = 520;
    const quote = await gate.getRequirements();
    expect(quote.extra).toEqual({ feePayer: b.feePayer });
    expect(quote.maxTimeoutSeconds).toBe(180);
    const res = await pay(quote);
    expect(res.status).toBe(200);
    expect(b.calls.verify).toBe(1);
    expect(b.calls.settle).toBe(1);
    expect(a.calls.verify + a.calls.settle + c.calls.verify + c.calls.settle).toBe(0);
  });

  it("a payment quoted by one facilitator is still settled by it after quotes moved on", async () => {
    a.down = undefined;
    // a is in its cooldown: quotes still go to b.
    expect((await gate.getRequirements()).extra).toEqual({ feePayer: b.feePayer });
    // A payment signed for c's fee payer (quoted by c before a restart, say) goes to c.
    const res = await pay({ scheme: "exact", network: NETWORK, asset: "0.0.0", amount: "500", payTo: "0.0.777", maxTimeoutSeconds: 180, extra: { feePayer: c.feePayer } });
    expect(res.status).toBe(200);
    expect(c.calls.settle).toBe(1);
    // An unknown fee payer matches no facilitator.
    const stranger = await pay({ scheme: "exact", network: NETWORK, asset: "0.0.0", amount: "500", payTo: "0.0.777", maxTimeoutSeconds: 180, extra: { feePayer: "0.0.9" } });
    expect(stranger.status).toBe(402);
    expect(((await stranger.json()) as { error: string }).error).toMatch(/does not match/);
  });

  it("moves new quotes to the next facilitator after it stops answering, keeping the settle retry", async () => {
    const quote = await gate.getRequirements();
    expect(quote.extra).toEqual({ feePayer: b.feePayer });
    b.down = 502;
    const before = b.calls.verify;
    const res = await pay(quote);
    // Signed for b, so it can only be settled by b: verify is asked again, then the payment is refused, never moved.
    expect(res.status).toBe(402);
    expect(b.calls.verify - before).toBe(3);
    const second = await pay(quote);
    expect(second.status).toBe(402);
    // Two calls without an answer: b is skipped, and the refusal already quotes the next one.
    const body = (await second.json()) as { accepts: PaymentRequirements[] };
    expect(body.accepts[0].extra).not.toEqual({ feePayer: b.feePayer });
    b.down = undefined;
  }, 20_000);

  it("a pool with no facilitator answering says so", async () => {
    const pool = new FacilitatorPool([`http://localhost:${BASE + 9}`], NETWORK, { cooldownMs: 1000, failuresToRotate: 1, probeTimeoutMs: 2000 });
    await expect(pool.pick()).rejects.toThrow(/no x402 facilitator available/);
  });
});
