import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { randomKey } from "../src/util/crypto.js";
import { encryptionKeyOf, unwrapKey, wrapContext, wrapKey } from "../src/util/wrap.js";

// Chunk keys wrapped to one provider's public key, bound to one job and chunk.

describe("wrapped chunk keys", () => {
  const provider = generatePrivateKey();
  const other = generatePrivateKey();
  const address = privateKeyToAccount(provider).address;
  const key = randomKey();
  const ctx = wrapContext("job-1", 3, address);

  it("opens only with the provider's private key and the same context", () => {
    const wrapped = wrapKey(encryptionKeyOf(provider), key, ctx);
    expect(Buffer.from(unwrapKey(provider, wrapped, ctx)).equals(Buffer.from(key))).toBe(true);
    expect(() => unwrapKey(other, wrapped, ctx)).toThrow(/not for this provider/);
    expect(() => unwrapKey(provider, wrapped, wrapContext("job-1", 4, address))).toThrow(/not for this provider or this chunk/);
    expect(() => unwrapKey(provider, wrapped, wrapContext("job-2", 3, address))).toThrow();
  });

  it("is fresh every time, and its public key is the provider's signing key", () => {
    const pub = encryptionKeyOf(provider);
    expect(pub).toMatch(/^0x0[23][0-9a-f]{64}$/);
    expect(wrapKey(pub, key, ctx)).not.toBe(wrapKey(pub, key, ctx));
    // The uncompressed form (as viem reports it) wraps to the same holder.
    const uncompressed = privateKeyToAccount(provider).publicKey;
    expect(Buffer.from(unwrapKey(provider, wrapKey(uncompressed, key, ctx), ctx)).equals(Buffer.from(key))).toBe(true);
  });

  it("refuses a tampered wrapping", () => {
    const wrapped = Buffer.from(wrapKey(encryptionKeyOf(provider), key, ctx), "base64");
    wrapped[wrapped.length - 20] ^= 1;
    expect(() => unwrapKey(provider, wrapped.toString("base64"), ctx)).toThrow();
  });
});
