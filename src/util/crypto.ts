import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function randomKey(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

/** HKDF-SHA256 sub-key, so each chunk (and the Arkiv reference wrapper) gets its own key. */
export function deriveKey(master: Uint8Array, label: string): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", master, new Uint8Array(0), `kinetic:${label}`, 32));
}

/** AES-256-GCM. Output layout: iv(12) | tag(16) | ciphertext. */
export function encrypt(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), ct]));
}

export function decrypt(key: Uint8Array, sealed: Uint8Array): Uint8Array {
  const buf = Buffer.from(sealed);
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]));
}

export function encryptJson(key: Uint8Array, value: unknown): Uint8Array {
  return encrypt(key, new TextEncoder().encode(JSON.stringify(value)));
}

export function decryptJson<T>(key: Uint8Array, sealed: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(decrypt(key, sealed))) as T;
}

/** Encrypts a string and returns base64, for values that end up in public Arkiv payloads. */
export function sealString(key: Uint8Array, value: string): string {
  return Buffer.from(encrypt(key, new TextEncoder().encode(value))).toString("base64");
}

export function openString(key: Uint8Array, sealed: string): string {
  return new TextDecoder().decode(decrypt(key, Buffer.from(sealed, "base64")));
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

/** Deterministic JSON (sorted keys, bigint as decimal string) for hashing and signing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** JSON.stringify replacer that keeps bigints readable in HTTP bodies. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * A hiding commitment to some data: HMAC-SHA256 under a secret key. Published without the key
 * it reveals nothing (not even for short, guessable data); the key holder can open it later.
 */
export function commitData(key: Uint8Array, value: unknown): string {
  return createHmac("sha256", key).update(canonicalJson(value)).digest("hex");
}
