import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

// Chunk keys travel wrapped to the one provider meant to use them (ECIES on secp256k1): an
// ephemeral key agrees a secret with the provider's public key, HKDF turns it into a key-
// encryption key, and AES-256-GCM seals the chunk key under it. The wrapping is bound to its
// context (job, chunk, provider), so a wrapped key can't be replayed into another request, and
// only the holder of the provider's private key can open it.
//
// A provider's public key is the same secp256k1 key it signs with; it publishes it in its
// Arkiv offer, which only it can write.

const CURVE = "secp256k1";
const IV = 12;
const TAG = 16;
const PUB = 33;

/** The compressed public key (0x + 66 hex) for a 0x-prefixed private key. */
export function encryptionKeyOf(privateKey: string): string {
  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(Buffer.from(privateKey.replace(/^0x/, ""), "hex"));
  return `0x${ecdh.getPublicKey("hex", "compressed")}`;
}

/** What a wrapped chunk key is bound to. */
export const wrapContext = (jobId: string, idx: number, provider: string) => `kinetic-chunk-key|${jobId}|${idx}|${provider.toLowerCase()}`;

function kek(shared: Buffer, ephemeral: Buffer, context: string): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, ephemeral, context, 32));
}

/** Seals `key` to the holder of `recipient` (a compressed or uncompressed secp256k1 public key). Base64. */
export function wrapKey(recipient: string, key: Uint8Array, context: string): string {
  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  const ephemeral = ecdh.getPublicKey(undefined, "compressed");
  const shared = ecdh.computeSecret(Buffer.from(recipient.replace(/^0x/, ""), "hex"));
  const iv = randomBytes(IV);
  const cipher = createCipheriv("aes-256-gcm", kek(shared, ephemeral, context), iv);
  cipher.setAAD(Buffer.from(context));
  const sealed = Buffer.concat([cipher.update(key), cipher.final()]);
  return Buffer.concat([ephemeral, iv, sealed, cipher.getAuthTag()]).toString("base64");
}

/** Opens a wrapped key with the recipient's private key. Throws if it isn't for this key or context. */
export function unwrapKey(privateKey: string, wrapped: string, context: string): Uint8Array {
  const raw = Buffer.from(wrapped, "base64");
  if (raw.length < PUB + IV + TAG + 1) throw new Error("wrapped key is too short");
  const ephemeral = raw.subarray(0, PUB);
  const iv = raw.subarray(PUB, PUB + IV);
  const tag = raw.subarray(raw.length - TAG);
  const sealed = raw.subarray(PUB + IV, raw.length - TAG);
  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(Buffer.from(privateKey.replace(/^0x/, ""), "hex"));
  const decipher = createDecipheriv("aes-256-gcm", kek(ecdh.computeSecret(ephemeral), ephemeral, context), iv);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  try {
    return new Uint8Array(Buffer.concat([decipher.update(sealed), decipher.final()]));
  } catch {
    throw new Error("could not unwrap the chunk key: not for this provider or this chunk");
  }
}
