import { keccak256, recoverMessageAddress, toBytes, type Hex, type LocalAccount } from "viem";
import { contentAddress } from "./swarm-bmt.js";

// Swarm single-owner chunks (SOCs), feeds and postage stamps, on the wire as Bee speaks them.
//
// A SOC is identifier (32) || signature (65) || span (8) || payload. Its address is
// keccak256(identifier || owner), and the owner signs keccak256(identifier || the wrapped
// chunk's content address) with Ethereum's personal_sign, so anyone can check who wrote it.
//
// A feed is a sequence of SOCs from one owner: update i of topic T has identifier
// keccak256(T || i as 8 bytes big-endian). Its payload (feed "v1", what Bee resolves for
// /feeds and /bzz feed manifests) is a timestamp (8 bytes big-endian, seconds) followed by
// the 32-byte reference the update points at.
//
// A postage stamp is batchId (32) || index (8) || timestamp (8, ns) || signature (65); the
// batch owner signs keccak256(chunk address || batchId || index || timestamp), personal_sign.

const ID = 32;
const SIG = 65;
const SPAN = 8;

const unhex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const hash = (b: Uint8Array) => keccak256(b, "bytes");

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u64(n: bigint, littleEndian: boolean): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, littleEndian);
  return b;
}

/** The feed topic KINETIC uses for a model's passports: one feed per model id, across versions. */
export const modelPassportTopicName = (modelId: string) => `kinetic.model-passport.v1:${modelId}`;

/** A feed topic from its name, as bee-js Topic.fromString does: keccak256 of the UTF-8 name. */
export const feedTopic = (name: string): string => hex(hash(toBytes(name)));

export function feedIdentifier(topic: string, index: bigint | number): Uint8Array {
  return hash(concat(unhex(topic), u64(BigInt(index), false)));
}

/** A SOC's address: keccak256(identifier || owner). */
export function socAddress(identifier: Uint8Array, owner: string): string {
  return hex(hash(concat(identifier, unhex(owner))));
}

/** The address of update `index` of a feed. */
export const feedUpdateAddress = (owner: string, topic: string, index: bigint | number) => socAddress(feedIdentifier(topic, index), owner);

export interface SocUpload {
  owner: string;
  identifier: string;
  signature: string;
  /** span || payload: the body of POST /soc/{owner}/{identifier}?sig={signature}. */
  data: Uint8Array;
  address: string;
}

/** Signs a feed update (v1 payload: timestamp || reference) as `account`. */
export async function makeFeedUpdate(account: LocalAccount, topic: string, index: bigint | number, reference: string, at = Date.now()): Promise<SocUpload> {
  if (!/^[0-9a-f]{64}$/i.test(reference)) throw new Error("a feed update points at a 64-hex Swarm reference");
  const identifier = feedIdentifier(topic, index);
  const payload = concat(u64(BigInt(Math.floor(at / 1000)), false), unhex(reference));
  const data = concat(u64(BigInt(payload.length), true), payload);
  const digest = hash(concat(identifier, unhex(contentAddress(data))));
  const signature = (await account.signMessage({ message: { raw: digest } })).slice(2);
  const owner = account.address.slice(2).toLowerCase();
  return { owner, identifier: hex(identifier), signature, data, address: socAddress(identifier, owner) };
}

/**
 * Parses and checks a SOC fetched from `address`: the signature recovers an owner, and that
 * owner with the identifier gives back the address. Throws if anything is off.
 */
export async function readSoc(chunk: Uint8Array, address: string): Promise<{ owner: string; identifier: string; span: bigint; payload: Uint8Array }> {
  if (chunk.length < ID + SIG + SPAN) throw new Error(`SOC ${address.slice(0, 12)}… is too short`);
  const identifier = chunk.subarray(0, ID);
  const signature = chunk.subarray(ID, ID + SIG);
  const wrapped = chunk.subarray(ID + SIG);
  const digest = hash(concat(identifier, unhex(contentAddress(wrapped))));
  let owner: string;
  try {
    owner = (await recoverMessageAddress({ message: { raw: digest }, signature: `0x${hex(signature)}` as Hex })).slice(2).toLowerCase();
  } catch {
    throw new Error(`SOC ${address.slice(0, 12)}… has no valid signature`);
  }
  if (socAddress(identifier, owner) !== address.toLowerCase()) throw new Error(`SOC ${address.slice(0, 12)}… is not signed by the owner its address names`);
  return { owner, identifier: hex(identifier), span: new DataView(wrapped.buffer, wrapped.byteOffset, SPAN).getBigUint64(0, true), payload: wrapped.subarray(SPAN) };
}

/** Reads a checked feed update: who signed it, when, and the reference it points at. */
export async function readFeedUpdate(chunk: Uint8Array, owner: string, topic: string, index: bigint | number): Promise<{ reference: string; timestamp: number }> {
  const address = feedUpdateAddress(owner, topic, index);
  const soc = await readSoc(chunk, address);
  if (soc.owner !== owner.replace(/^0x/, "").toLowerCase()) throw new Error("feed update is signed by someone else");
  if (soc.payload.length !== 40) throw new Error(`feed update holds ${soc.payload.length} bytes, not a timestamp and a reference`);
  return { timestamp: Number(new DataView(soc.payload.buffer, soc.payload.byteOffset, 8).getBigUint64(0, false)), reference: hex(soc.payload.subarray(8)) };
}

// ── Postage stamps ──

export const STAMP_BYTES = 32 + 8 + 8 + 65;
const BUCKET_DEPTH = 16;

/** Signs one postage stamp for a chunk address, at a (bucket, slot) index the caller reserved. */
export async function signStamp(account: LocalAccount, batchId: string, address: string, slot: number, at = Date.now()): Promise<string> {
  const addr = unhex(address);
  const bucket = (addr[0] << 8) | addr[1];
  const index = new Uint8Array(8);
  new DataView(index.buffer).setUint32(0, bucket, false);
  new DataView(index.buffer).setUint32(4, slot, false);
  const timestamp = u64(BigInt(at) * 1_000_000n, false);
  const batch = unhex(batchId);
  const signature = unhex((await account.signMessage({ message: { raw: hash(concat(addr, batch, index, timestamp)) } })).slice(2));
  return hex(concat(batch, index, timestamp, signature));
}

/** Who signed a stamp for `address`, and at which index; throws if it isn't for this chunk. */
export async function readStamp(stamp: string, address: string): Promise<{ batchId: string; issuer: string; bucket: number; slot: number }> {
  const b = unhex(stamp);
  if (b.length !== STAMP_BYTES) throw new Error("a postage stamp is 113 bytes");
  const batch = b.subarray(0, 32);
  const index = b.subarray(32, 40);
  const timestamp = b.subarray(40, 48);
  const digest = hash(concat(unhex(address), batch, index, timestamp));
  const issuer = (await recoverMessageAddress({ message: { raw: digest }, signature: `0x${hex(b.subarray(48))}` as Hex })).slice(2).toLowerCase();
  const view = new DataView(index.buffer, index.byteOffset, 8);
  const bucket = view.getUint32(0, false);
  const addr = unhex(address);
  if (bucket !== ((addr[0] << 8) | addr[1])) throw new Error("stamp is for another bucket");
  return { batchId: hex(batch), issuer, bucket, slot: view.getUint32(4, false) };
}

/** Slots per bucket in a batch of this depth. */
export const slotsPerBucket = (depth: number) => 2 ** (depth - BUCKET_DEPTH);
