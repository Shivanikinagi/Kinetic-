import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { BuyerAgent } from "../src/agent/buyer.js";
import { loadNetworkConfig } from "../src/config.js";
import { ensureDevnetFunds, startDevnet, type Devnet } from "./support/devnet.js";
import { agentProfile, uaidFor, verifyUaid } from "../src/integrations/identity.js";
import { connect, type Services } from "../src/integrations/index.js";
import { creditedAmount } from "../src/integrations/mirror.js";
import { HeuristicBackend } from "./support/heuristic.js";
import { startProvider, type RunningProvider } from "../src/provider/node.js";
import { formatAmount, HBAR } from "../src/types.js";
import { createApp, listen } from "../src/util/http.js";

describe("HCS-14 identity", () => {
  const profile = agentProfile({ role: "provider", name: "atlas-4090", network: "testnet", hederaAccountId: "0.0.11212786", evmAddress: "0xABC" });

  it("derives the same UAID as the HCS-14 SDK", async () => {
    expect(profile.nativeId).toBe("hedera:testnet:0.0.11212786");
    // Matches @hashgraphonline/standards-sdk createUaid for this profile.
    expect(await uaidFor({ ...profile, skills: [] }, "0xabc")).toBe(
      "uaid:aid:1dWzojWMBCw5fNkdpP6XNCADtpGFfqEb4D2dH7UYCPe6SVcVwX2Fz1ZT5dJ2ef87W;uid=0xabc;registry=kinetic;nativeId=hedera:testnet:0.0.11212786",
    );
  });

  it("rejects a UAID that doesn't match its profile or address", async () => {
    const uaid = await uaidFor(profile, "0xabc");
    expect(await verifyUaid(uaid, profile, "0xABC")).toBe(true);
    expect(await verifyUaid(uaid, { ...profile, name: "impostor" }, "0xabc")).toBe(false);
    expect(await verifyUaid(uaid, profile, "0xdef")).toBe(false);
  });
});

describe("payment asset", () => {
  it("pays in HBAR only, whatever the environment says, and still formats old token amounts", () => {
    const kusd = { id: "0.0.11220110", symbol: "KUSD", decimals: 8 };
    expect(formatAmount(1000n, kusd)).toBe("0.00001 KUSD");
    expect(formatAmount(150_000_000n, kusd)).toBe("1.5 KUSD");
    expect(formatAmount(360_000n, HBAR)).toBe("0.0036 ℏ");
    const cfg = loadNetworkConfig({ KINETIC_NETWORK: "devnet", X402_ASSET: "0.0.5", X402_ASSET_SYMBOL: "USDC", X402_ASSET_DECIMALS: "6", X402_REFUND_RATE: "12.5" });
    expect(cfg.x402).toEqual({ network: "kinetic:devnet", facilitatorUrl: `${cfg.devnetUrl}/facilitator`, facilitatorUrls: [`${cfg.devnetUrl}/facilitator`], asset: "0.0.0", symbol: "HBAR", decimals: 8 });
  });

  it("counts token transfers when checking a passport from a job that settled in an HTS token", async () => {
    const app = createApp();
    app.get("/api/v1/transactions/:id", (_req, res) => {
      res.json({
        transactions: [
          {
            result: "SUCCESS",
            transfers: [{ account: "0.0.7", amount: 5 }],
            token_transfers: [
              { token_id: "0.0.900", account: "0.0.7", amount: 1000 },
              { token_id: "0.0.901", account: "0.0.7", amount: 99 },
            ],
          },
        ],
      });
    });
    const server = await listen(app, 4860);
    try {
      expect(await creditedAmount("http://localhost:4860", "0.0.1@1.2", "0.0.7", "0.0.900", 1)).toBe(1000n);
      expect(await creditedAmount("http://localhost:4860", "0.0.1@1.2", "0.0.7", "0.0.0", 1)).toBe(5n);
    } finally {
      server.close();
    }
  });
});

describe("discovery checks identities", () => {
  const PORT = 4870;
  let devnet: Devnet;
  let svc: Services;
  let provider: RunningProvider;
  let verifierStub: Server;

  beforeAll(async () => {
    devnet = await startDevnet({ port: PORT });
    svc = connect(loadNetworkConfig({ KINETIC_NETWORK: "devnet", DEVNET_URL: devnet.url }), { privateKey: generatePrivateKey() });
    await ensureDevnetFunds(svc);
    provider = await startProvider(
      { name: "honest-id", port: PORT + 2, gpu: "test", tasks: ["classify"], priceTinybar: 1000n, bondTinybar: 10_000n, backend: new HeuristicBackend(), behavior: { kind: "honest" }, heartbeatMs: 60_000 },
      svc,
    );
    const app = createApp();
    app.get("/status", (_req, res) => void res.json({ verifier: "0x0000000000000000000000000000000000000001" }));
    verifierStub = await listen(app, PORT + 3);
  }, 30_000);

  afterAll(async () => {
    verifierStub?.close();
    await provider?.close();
    await devnet?.close();
  });

  it("keeps an offer whose UAID matches, and skips it once the UAID is forged", async () => {
    const buyer = new BuyerAgent(svc, `http://localhost:${PORT + 3}`, { maxPricePerChunk: 10n ** 9n, maxJobSpend: 10n ** 9n });
    const before = await buyer.discover("classify");
    expect(before.map((o) => o.name)).toEqual(["honest-id"]);
    expect(before[0].uaid).toMatch(/^uaid:aid:/);

    await svc.arkiv.patch(provider.offerKey, { uaid: "uaid:aid:forged" });
    expect(await buyer.discover("classify")).toEqual([]);
  });
});
