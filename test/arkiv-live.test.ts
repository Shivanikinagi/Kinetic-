import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadNetworkConfig } from "../src/config.js";
import { ArkivSdkStore, TTL, assertFilterable, type ArkivStore } from "../src/integrations/arkiv.js";
import { connect, type Services } from "../src/integrations/index.js";
import { signedPost } from "../src/util/sign.js";
import { ArkivMirror, type MirrorChange } from "../src/verifier/arkiv-mirror.js";
import { startVerifier } from "../src/verifier/service.js";
import { startDevnet, type Devnet } from "./support/devnet.js";

// Named schemas and typed columns, readonly checks and trust by creator, server sort and count,
// and the live mirror that keeps the dashboard current from Arkiv's entity events.

const PORT = 4940;
let devnet: Devnet;
let a: Services;
let b: Services;

beforeAll(async () => {
  devnet = await startDevnet({ port: PORT });
  const cfg = loadNetworkConfig({ KINETIC_NETWORK: "devnet", DEVNET_URL: devnet.url });
  a = connect(cfg, { privateKey: generatePrivateKey() });
  b = connect(cfg, { privateKey: generatePrivateKey() });
});

afterAll(async () => {
  await devnet?.close();
});

const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("Arkiv writes (SDK store, fake wallet)", () => {
  function fakeStore() {
    const store = new ArkivSdkStore(privateKeyToAccount(generatePrivateKey()), { rpcUrl: "http://127.0.0.1:1", chainId: 7794095, explorerUrl: "" });
    const sent: { creates: { schema: { name?: string; columns: Record<string, { type: string; isIndexed: boolean }> }; values: Record<string, { type: string; value: unknown }>; flags?: { readonly?: boolean } }[]; patches: { schema: { name?: string; columns: Record<string, { type: string; isIndexed: boolean }> } }[] }[] = [];
    let n = 0;
    (store as unknown as { wallet: unknown }).wallet = {
      executeBatch: async (batch: (typeof sent)[number]) => {
        sent.push({ creates: batch.creates ?? [], patches: batch.patches ?? [] });
        return { txHash: "0x", createdEntities: (batch.creates ?? []).map(() => `0x${(++n).toString(16).padStart(64, "0")}`) };
      },
    };
    return { store, sent };
  }

  it("writes each kind through its named schema, with typed columns indexed only where filtered", async () => {
    const { store, sent } = fakeStore();
    const provider = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    await store.create({ kind: "offer", ttlSeconds: TTL.offer, attrs: { provider, name: "gpu-1", price: 1000, "task.classify": 1, "model.abc": 1 }, payload: { x: 1 } });
    const offer = sent[0].creates[0];
    expect(offer.schema.name).toBe("kinetic.offer");
    expect(offer.values).not.toHaveProperty("kind"); // the schema tag replaces it
    expect(offer.values.provider.type).toBe("addr");
    expect(offer.schema.columns.provider.isIndexed).toBe(true);
    expect(offer.schema.columns.price).toMatchObject({ type: "u64", isIndexed: true });
    expect(offer.schema.columns.name.isIndexed).toBe(false);
    expect(offer.schema.columns["task.classify"].isIndexed).toBe(true);
    expect(offer.schema.columns["model.abc"].isIndexed).toBe(true);
    expect(offer.schema.columns.payload.type).toBe("bytes");
    expect(offer.flags).toBeUndefined();
  });

  it("creates checks readonly, links chunks to their job by key, and types a patch by the entity's kind", async () => {
    const { store, sent } = fakeStore();
    await store.create({ kind: "check", ttlSeconds: TTL.check, readonly: true, attrs: { provider: "0x00000000000000000000000000000000000000aa", src: "canary", pass: 1, at: 1 } });
    expect(sent[0].creates[0].flags).toEqual({ readonly: true });
    expect(sent[0].creates[0].schema.columns.src.isIndexed).toBe(false);
    const job = `0x${"ab".repeat(32)}`;
    const chunk = await store.create({ kind: "chunk", ttlSeconds: TTL.job, attrs: { job_id: "j", job_key: job, idx: 0, status: "pending", provider: "" } });
    const c = sent[1].creates[0];
    expect(c.values.job_key.type).toBe("key");
    // No provider yet: the zero address (read back as "").
    expect(c.values.provider).toEqual({ type: "addr", value: "0x0000000000000000000000000000000000000000" });
    await store.patch(chunk, { status: "done", provider: "0x00000000000000000000000000000000000000bb" });
    const p = sent[2].patches[0];
    expect(p.schema.name).toBeUndefined();
    expect(p.schema.columns.provider).toMatchObject({ type: "addr", isIndexed: false });
    expect(p.schema.columns.status.isIndexed).toBe(false);
  });

  it("refuses to filter on a column that isn't indexed", () => {
    expect(() => assertFilterable("check", { src: "canary" })).toThrow(/not indexed/);
    expect(() => assertFilterable("check", { provider: "0x1", pass: 1 })).not.toThrow();
    expect(() => assertFilterable("offer", { "task.extract": 1, "model.k": 1 })).not.toThrow();
  });
});

describe("Arkiv reads (devnet)", () => {
  it("finds entities written before named schemas alongside new ones", async () => {
    // As the store wrote them before: a `kind` attribute and no schema tag.
    const res = await signedPost(a.account, `${devnet.url}/arkiv/create`, { attrs: { app: a.arkiv.app, kind: "job", job_id: "legacy-1" }, payload: {}, ttlSeconds: 60 });
    expect(res.ok).toBe(true);
    await a.arkiv.create({ kind: "job", ttlSeconds: 60, attrs: { job_id: "legacy-1" } });
    const found = await a.arkiv.query("job", { job_id: "legacy-1" });
    expect(found).toHaveLength(2);
    expect(found.filter((e) => e.legacy)).toHaveLength(1);
    expect(found.every((e) => e.kind === "job")).toBe(true);
    expect(found.every((e) => !("arkiv.schema" in e.attrs))).toBe(true);
    // Another kind with the same attributes isn't matched.
    expect(await a.arkiv.query("chunk", { job_id: "legacy-1" })).toHaveLength(0);
  });

  it("never lets a readonly check change, and trusts it by creator", async () => {
    const key = await a.arkiv.create({ kind: "check", ttlSeconds: 60, readonly: true, attrs: { provider: b.address, src: "canary", pass: 1, at: 10 } });
    await expect(a.arkiv.patch(key, { pass: 0 })).rejects.toThrow(/readonly/);
    await a.arkiv.extend(key, 120); // expiry can still move
    // Someone else writes a check about the same provider: it isn't the verifier's.
    await b.arkiv.create({ kind: "check", ttlSeconds: 60, readonly: true, attrs: { provider: b.address, src: "canary", pass: 0, at: 11 } });
    const trusted = await a.arkiv.query("check", { provider: b.address }, { creator: a.address });
    expect(trusted.map((c) => c.key)).toEqual([key]);
    expect(trusted[0]).toMatchObject({ creator: a.address, readonly: true });
  });

  it("sorts and counts on the server", async () => {
    const p = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    for (const [at, pass] of [[5, 1], [9, 0], [7, 1]] as const) await a.arkiv.create({ kind: "check", ttlSeconds: 60, readonly: true, attrs: { provider: p, src: "canary", pass, at } });
    const { entities, total } = await a.arkiv.queryCounted("check", { provider: p }, { creator: a.address, limit: 2, orderBy: { attr: "at", desc: true } });
    expect(total).toBe(3);
    expect(entities.map((e) => Number(e.attrs.at))).toEqual([9, 7]);
    expect(await a.arkiv.count("check", { provider: p, pass: 1 }, { creator: a.address })).toBe(2);
  });
});

describe("live mirror", () => {
  it("follows entity events with getEntity reads only, and sweeps expired entities", async () => {
    const store: ArkivStore = a.arkiv;
    const mirror = new ArkivMirror(store, { kinds: ["offer", "claim"], pollMs: { offer: 8000, claim: 6000 }, reconcileMs: 600_000 });
    const changes: MirrorChange[] = [];
    const unsubscribe = mirror.subscribe((c) => changes.push(c));
    try {
      const first = await mirror.snapshot("claim");
      await mirror.snapshot("offer");
      const queriesAfterLoad = store.reads.queries;
      const getsBefore = store.reads.gets;

      // Created: read once with getEntity and pushed.
      const key = (await b.arkiv.create({ kind: "claim", ttlSeconds: 3, attrs: { job_id: "live-1", idx: 0, provider: b.address } })).toLowerCase();
      await until(() => changes.some((c) => c.kind === "claim" && c.upserts.some((e) => e.key === key)));
      const created = changes.flatMap((c) => c.upserts).find((e) => e.key === key)!;
      expect(created).toMatchObject({ owner: b.address, creator: b.address, attrs: { job_id: "live-1", idx: 0 } });
      expect((await mirror.snapshot("claim")).entities.length).toBe(first.entities.length + 1);

      // Another app's entity, or a kind not mirrored, is read once and then ignored.
      await b.arkiv.create({ kind: "job", ttlSeconds: 60, attrs: { job_id: "not-mirrored" } });

      // Patched: re-read; the change carries the new attributes.
      changes.length = 0;
      await b.arkiv.patch(key, { idx: 3 });
      await until(() => changes.some((c) => c.upserts.some((e) => e.key === key && e.attrs.idx === 3)));

      // Arkiv has no expiry event: the mirror drops it at its expiry time.
      changes.length = 0;
      await until(() => changes.some((c) => c.removes.includes(key)), 6000);
      expect((await mirror.snapshot("claim")).entities.some((e) => e.key === key)).toBe(false);

      // Deleted: removed without a read.
      const offerKey = (await b.arkiv.create({ kind: "offer", ttlSeconds: 60, attrs: { provider: b.address, price: 1 } })).toLowerCase();
      await until(() => changes.some((c) => c.upserts.some((e) => e.key === offerKey)));
      const gets = store.reads.gets;
      await b.arkiv.remove(offerKey);
      await until(() => changes.some((c) => c.removes.includes(offerKey)));
      expect(store.reads.gets).toBe(gets);

      // No metered query after the first full read; only getEntity.
      expect(store.reads.queries).toBe(queriesAfterLoad);
      expect(store.reads.gets).toBeGreaterThan(getsBefore);
      expect(mirror.stats().events).toBeGreaterThan(0);
    } finally {
      unsubscribe();
      mirror.stop();
    }
  }, 20_000);

  it("streams snapshots and changes to the dashboard over Server-Sent Events", async () => {
    const verifier = await startVerifier(a, PORT + 1);
    try {
      const ctrl = new AbortController();
      const res = await fetch(`${verifier.url}/arkiv/events?kinds=offer`, { signal: ctrl.signal });
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
      const reader = res.body!.getReader();
      let text = "";
      const read = async (until: (t: string) => boolean) => {
        const end = Date.now() + 5000;
        while (!until(text) && Date.now() < end) text += new TextDecoder().decode((await reader.read()).value);
        return until(text);
      };
      expect(await read((t) => t.includes("event: snapshot"))).toBe(true);
      const key = (await b.arkiv.create({ kind: "offer", ttlSeconds: 60, attrs: { provider: b.address, name: "sse", price: 2 } })).toLowerCase();
      expect(await read((t) => t.includes("event: change") && t.includes(key))).toBe(true);
      ctrl.abort();
      // The same mirror serves the plain read, and reports what it spent.
      const body = (await (await fetch(`${verifier.url}/arkiv/offer`)).json()) as { live: boolean; entities: { key: string; creator?: string }[] };
      expect(body.entities.find((e) => e.key === key)?.creator).toBe(b.address);
      const stats = (await (await fetch(`${verifier.url}/arkiv/stats`)).json()) as { running: boolean; gets: number };
      expect(stats.running).toBe(true);
    } finally {
      await verifier.close();
    }
  }, 30_000);
});
