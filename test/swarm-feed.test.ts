import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadNetworkConfig, type NetworkConfig } from "../src/config.js";
import { swarmChunks } from "../src/integrations/swarm-bmt.js";
import { feedTopic, feedUpdateAddress, makeFeedUpdate, modelPassportTopicName, readFeedUpdate, readSoc, readStamp, signStamp } from "../src/integrations/swarm-feed.js";
import { PostageStamper } from "../src/integrations/swarm-stamper.js";
import { isPublicGateway, SwarmClient } from "../src/integrations/swarm.js";
import { startDevnet, type Devnet } from "./support/devnet.js";

// Swarm feeds (signed single-owner chunks), client-side postage stamps, and plain 64-hex
// uploads on public gateways.

const PORT = 4760;
const batchOwner = generatePrivateKey();
const BATCH = "ab".repeat(32);
let devnet: Devnet;
let cfg: NetworkConfig;

beforeAll(async () => {
  devnet = await startDevnet({ port: PORT, postageBatch: { id: BATCH, owner: privateKeyToAccount(batchOwner).address } });
  cfg = loadNetworkConfig({ KINETIC_NETWORK: "devnet", DEVNET_URL: devnet.url });
});
afterAll(() => devnet?.close());

describe("Swarm feeds", () => {
  it("builds and checks signed updates: topic, identifier, SOC address and signature", async () => {
    // Topics are keccak256 of their name, as bee-js Topic.fromString makes them.
    const account = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000001");
    expect(feedTopic("hello")).toBe("1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8");
    const soc = await makeFeedUpdate(account, feedTopic("hello"), 0, "a2322ed653c075c08a7847275537b74ba9f523c55341efe3df85565a78c6bb4a", 1_700_000_000_000);
    expect(soc.address).toBe(feedUpdateAddress(soc.owner, feedTopic("hello"), 0));
    const chunk = Buffer.concat([Buffer.from(soc.identifier, "hex"), Buffer.from(soc.signature, "hex"), soc.data]);
    const read = await readFeedUpdate(chunk, soc.owner, feedTopic("hello"), 0);
    expect(read).toEqual({ reference: "a2322ed653c075c08a7847275537b74ba9f523c55341efe3df85565a78c6bb4a", timestamp: 1_700_000_000 });
    // A changed byte, or the same chunk claimed at another address, is refused.
    const bad = Buffer.from(chunk);
    bad[bad.length - 1] ^= 1;
    await expect(readSoc(bad, soc.address)).rejects.toThrow();
    await expect(readFeedUpdate(chunk, soc.owner, feedTopic("hello"), 1)).rejects.toThrow();
  });

  it("publishes a model's passports on one feed, newest last, with a stable manifest", async () => {
    const swarm = new SwarmClient(cfg.swarm);
    const publisher = privateKeyToAccount(generatePrivateKey());
    const topic = modelPassportTopicName("acme/sentiment");
    expect(await swarm.readFeed(publisher.address, topic)).toBeUndefined();

    const v1 = await swarm.uploadFile(new TextEncoder().encode('{"v":1}'), "m1.json", "application/json");
    const a = await swarm.publishFeed(publisher, topic, v1);
    const v2 = await swarm.uploadFile(new TextEncoder().encode('{"v":2}'), "m2.json", "application/json");
    const b = await swarm.publishFeed(publisher, topic, v2);
    expect([a.index, b.index]).toEqual([0, 1]);
    expect(b.manifest).toBe(a.manifest);
    expect((await swarm.readFeed(publisher.address, topic))!).toMatchObject({ index: 1, reference: v2 });
    expect(await (await fetch(swarm.feedUrl(b.manifest))).json()).toEqual({ v: 2 });
  });

  it("refuses an update not signed by the feed's owner", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const forger = privateKeyToAccount(generatePrivateKey());
    const soc = await makeFeedUpdate(forger, feedTopic("x"), 0, "00".repeat(32));
    const res = await fetch(`${cfg.swarm.beeUrl}/soc/${owner.address.slice(2)}/${soc.identifier}?sig=${soc.signature}`, { method: "POST", body: Buffer.from(soc.data) });
    expect(res.status).toBe(401);
  });
});

describe("Postage stamps", () => {
  it("stamps every chunk with the batch owner's key; the gateway checks them", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "kinetic-stamps-"));
    const swarm = new SwarmClient({ ...cfg.swarm, postageBatchId: BATCH, stampKey: batchOwner, postageDepth: 17 }, { stampStateFile: join(stateDir, "stamps.json") });
    const data = Uint8Array.from({ length: 20_000 }, (_, i) => (i * 7) % 256);
    const ref = await swarm.upload(data, { encrypt: true });
    expect(ref).toBe(swarmChunks(data).reference);
    expect(Buffer.compare(Buffer.from(await swarm.download(ref)), Buffer.from(data))).toBe(0);
    // A feed update is stamped too.
    const publisher = privateKeyToAccount(generatePrivateKey());
    expect((await swarm.publishFeed(publisher, "stamped", ref)).index).toBe(0);

    // Someone else's key can't spend the batch.
    const thief = new SwarmClient({ ...cfg.swarm, postageBatchId: BATCH, stampKey: generatePrivateKey(), postageDepth: 17 });
    await expect(thief.upload(new TextEncoder().encode("not yours"))).rejects.toThrow(/invalid batch id/);
  });

  it("never hands out a slot twice, across clients sharing the counters", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "kinetic-stamps-")), "stamps.json");
    const account = privateKeyToAccount(batchOwner);
    const a = new PostageStamper(account, BATCH, 18, file);
    const b = new PostageStamper(account, BATCH, 18, file);
    const same = "0000".padEnd(64, "1");
    const stamps = await Promise.all([a.stamp([same, same]), b.stamp([same]), a.stamp([same])]);
    const slots = await Promise.all(stamps.flat().map((s) => readStamp(s, same).then((r) => r.slot)));
    expect(new Set(slots).size).toBe(4);
    // Depth 17: two slots per bucket, then the batch is full there.
    const small = new PostageStamper(account, BATCH, 17);
    await small.stamp([same, same]);
    await expect(small.stamp([same])).rejects.toThrow(/full/);
    // A stamp is bound to its chunk.
    const s = await signStamp(account, BATCH, same, 0);
    expect((await readStamp(s, same)).issuer).toBe(account.address.slice(2).toLowerCase());
    expect((await readStamp(s, "0000".padEnd(64, "2"))).issuer).not.toBe(account.address.slice(2).toLowerCase());
  });
});

describe("Public gateway", () => {
  it("is recognised, and Swarm encryption is never used on it", async () => {
    expect(isPublicGateway("https://api.gateway.ethswarm.org")).toBe(true);
    expect(isPublicGateway("http://localhost:1633")).toBe(false);
    const prod = loadNetworkConfig({ KINETIC_NETWORK: "testnet", SWARM_ENCRYPT: "true" });
    expect(prod.swarm.beeUrl).toBe("https://api.gateway.ethswarm.org");
    expect(prod.swarm.redundancy).toBe(2);
    // Off unless asked for, and on a public gateway an upload asked to encrypt goes up plain.
    expect(loadNetworkConfig({ KINETIC_NETWORK: "testnet" }).swarm.encrypt).toBe(false);
    let sent: Headers | undefined;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = new Headers(init.headers);
      return new Response(JSON.stringify({ reference: "11".repeat(32) }), { status: 201 });
    }) as typeof fetch;
    try {
      const ref = await new SwarmClient(prod.swarm).upload(new TextEncoder().encode("sealed"), { redundancy: 2 });
      expect(ref).toHaveLength(64);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(sent!.get("swarm-encrypt")).toBeNull();
    expect(sent!.get("swarm-redundancy-level")).toBe("2");
  });
});
