import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ArkivSdkStore } from "../src/integrations/arkiv.js";

// The SDK store batches writes through one queue per wallet. These tests replace the SDK
// wallet with a fake, so they exercise the queue without a network.

function storeWithFakeWallet() {
  const store = new ArkivSdkStore(privateKeyToAccount(generatePrivateKey()), { rpcUrl: "http://127.0.0.1:1", chainId: 7738577, explorerUrl: "" });
  const batches: { creates: number; patches: { entityKey: string; set: Record<string, unknown> }[] }[] = [];
  let n = 0;
  (store as unknown as { wallet: unknown }).wallet = {
    executeBatch: async (b: { creates?: unknown[]; patches?: { entityKey: string; set: Record<string, unknown> }[] }) => {
      await new Promise((r) => setTimeout(r, 5));
      batches.push({ creates: b.creates?.length ?? 0, patches: b.patches ?? [] });
      return { txHash: "0x", createdEntities: (b.creates ?? []).map(() => `0x${(++n).toString(16).padStart(64, "0")}`), patchedEntities: [], deletedEntities: [], extendedEntities: [], ownershipChanges: [] };
    },
  };
  return { store, batches };
}

describe("Arkiv SDK write queue", () => {
  it("does not strand a write queued as the previous batch finishes", async () => {
    const { store } = storeWithFakeWallet();
    const first = await store.create({ kind: "job", attrs: { job_id: "j" }, ttlSeconds: 60 });
    // Queued in the continuation of the first write: the exact timing that used to hang.
    const rest = await Promise.race([
      Promise.all([1, 2, 3].map((i) => store.create({ kind: "chunk", attrs: { job_id: "j", idx: i }, ttlSeconds: 60 }))),
      new Promise((_, reject) => setTimeout(() => reject(new Error("write stranded in the queue")), 1000)),
    ]);
    expect(first).toMatch(/^0x/);
    expect(rest).toHaveLength(3);
  });

  it("merges patches to the same entity into one operation", async () => {
    const { store, batches } = storeWithFakeWallet();
    const key = await store.create({ kind: "chunk", attrs: { idx: 0 }, ttlSeconds: 60 });
    await Promise.all([store.patch(key, { status: "claimed" }), store.patch(key, { status: "done", provider: "p" })]);
    const patchBatch = batches.find((b) => b.patches.length > 0)!;
    expect(patchBatch.patches).toHaveLength(1);
    expect(Object.keys(patchBatch.patches[0].set).sort()).toEqual(["provider", "status"]);
  });
});
