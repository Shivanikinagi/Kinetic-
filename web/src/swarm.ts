import { bytesToHex, hexToBytes, keccak256, recoverMessageAddress, toBytes } from "viem";

// Swarm, checked in the browser: content addresses (BMT) and signed feed updates (single-owner
// chunks), the same checks as src/integrations/swarm-bmt.ts and swarm-feed.ts, so the page
// doesn't take the gateway's word for what it serves.

const CHUNK = 4096;
const SEG = 32;

const hex = (b: Uint8Array) => bytesToHex(b).slice(2);
const unhex = (h: string) => hexToBytes(`0x${h.replace(/^0x/, "")}`);
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

function bmtRoot(payload: Uint8Array): Uint8Array {
  const padded = new Uint8Array(CHUNK);
  padded.set(payload);
  let level: Uint8Array[] = [];
  for (let i = 0; i < CHUNK; i += SEG) level.push(padded.subarray(i, i + SEG));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(hash(concat(level[i], level[i + 1])));
    level = next;
  }
  return level[0];
}

/** A raw chunk's (span || payload) content address. */
const contentAddress = (chunk: Uint8Array) => hex(hash(concat(chunk.subarray(0, 8), bmtRoot(chunk.subarray(8)))));

async function getChunk(gateway: string, address: string): Promise<Uint8Array> {
  const res = await fetch(`${gateway}/chunks/${address}`);
  if (!res.ok) throw new Error(`gateway answered ${res.status} for chunk ${address.slice(0, 12)}…`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * The bytes under a 64-hex reference, every chunk checked against its address on the way down
 * (erasure-coded roots too: data children are read until the span is covered).
 */
export async function fetchVerified(gateway: string, reference: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const walk = async (address: string, depth: number): Promise<bigint> => {
    if (depth > 8) throw new Error("Swarm tree is too deep");
    const chunk = await getChunk(gateway, address);
    if (chunk.length < 8 || chunk.length > 8 + CHUNK) throw new Error(`chunk ${address.slice(0, 12)}… has a bad size`);
    if (contentAddress(chunk) !== address) throw new Error(`chunk ${address.slice(0, 12)}… does not match its address`);
    const span = chunk.slice(0, 8);
    if (span[7] & 0x80) span[7] = 0;
    const size = new DataView(span.buffer).getBigUint64(0, true);
    const payload = chunk.subarray(8);
    if (size <= BigInt(CHUNK)) {
      if (BigInt(payload.length) !== size) throw new Error(`chunk ${address.slice(0, 12)}… is not the size its span says`);
      parts.push(payload);
      return size;
    }
    let got = 0n;
    for (let i = 0; i + SEG <= payload.length && got < size; i += SEG) got += await walk(hex(payload.subarray(i, i + SEG)), depth + 1);
    if (got !== size) throw new Error(`chunk ${address.slice(0, 12)}…: children add up to ${got} bytes, not ${size}`);
    return size;
  };
  if (!/^[0-9a-f]{64}$/i.test(reference)) throw new Error("not a 64-hex reference");
  await walk(reference.toLowerCase(), 0);
  return concat(...parts);
}

export const modelPassportTopicName = (modelId: string) => `kinetic.model-passport.v1:${modelId}`;
export const feedTopic = (name: string) => hex(hash(toBytes(name)));

function feedUpdateAddress(owner: string, topic: string, index: number): { identifier: Uint8Array; address: string } {
  const i = new Uint8Array(8);
  new DataView(i.buffer).setBigUint64(0, BigInt(index), false);
  const identifier = hash(concat(unhex(topic), i));
  return { identifier, address: hex(hash(concat(identifier, unhex(owner)))) };
}

export interface FeedUpdate {
  index: number;
  /** The update's own address, a single-owner chunk. */
  address: string;
  /** Who signed it (recovered from its signature). */
  signer: string;
  reference: string;
  timestamp: number;
}

/**
 * A feed's newest update. The gateway only says which index is newest; the update is fetched
 * by its own address and must be signed by `owner` (signature over the identifier and the
 * wrapped chunk's BMT address, recovered here).
 */
export async function latestFeedUpdate(gateway: string, owner: string, topic: string): Promise<FeedUpdate | null> {
  const o = owner.replace(/^0x/, "").toLowerCase();
  // A plain GET (no custom headers, so no CORS preflight); the gateway exposes Swarm-Feed-Index.
  const res = await fetch(`${gateway}/feeds/${o}/${topic}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`gateway answered ${res.status} for the feed`);
  const header = res.headers.get("swarm-feed-index");
  if (!header) throw new Error("gateway didn't say which update is newest");
  const index = Number(BigInt(`0x${header}`));
  const { identifier, address } = feedUpdateAddress(o, topic, index);
  const chunk = await getChunk(gateway, address);
  if (chunk.length < 32 + 65 + 8 + 40) throw new Error("feed update is too short");
  if (hex(chunk.subarray(0, 32)) !== hex(identifier)) throw new Error("feed update has another identifier");
  const wrapped = chunk.subarray(32 + 65);
  const digest = hash(concat(identifier, unhex(contentAddress(wrapped))));
  const signer = (await recoverMessageAddress({ message: { raw: digest }, signature: bytesToHex(chunk.subarray(32, 32 + 65)) })).slice(2).toLowerCase();
  if (signer !== o) throw new Error(`feed update is signed by 0x${signer}, not the feed's owner`);
  const payload = wrapped.subarray(8);
  if (payload.length !== 40) throw new Error("feed update doesn't hold a timestamp and a reference");
  return { index, address, signer, timestamp: Number(new DataView(payload.buffer, payload.byteOffset, 8).getBigUint64(0, false)), reference: hex(payload.subarray(8)) };
}
