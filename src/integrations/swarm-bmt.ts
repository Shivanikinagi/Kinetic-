import { keccak256 } from "viem";

// Swarm content addressing, so a download can be checked against its reference instead of
// trusting the gateway. Data is split into 4096-byte chunks. A chunk's address is
// keccak256(span || BMT root), where span is the little-endian uint64 byte count under it and
// the BMT root is a binary keccak256 Merkle tree over the payload, zero-padded to 4096 bytes
// in 32-byte segments. Intermediate chunks hold up to 128 child addresses; a lone last child
// at a level is carried up unwrapped, as Bee's splitter does.

const CHUNK_SIZE = 4096;
const SEGMENT = 32;
const BRANCHES = CHUNK_SIZE / SEGMENT;

function bmtRoot(payload: Uint8Array): Uint8Array {
  let level: Uint8Array[] = [];
  const padded = new Uint8Array(CHUNK_SIZE);
  padded.set(payload);
  for (let i = 0; i < CHUNK_SIZE; i += SEGMENT) level.push(padded.subarray(i, i + SEGMENT));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(hash(concat(level[i], level[i + 1])));
    level = next;
  }
  return level[0];
}

/** The content address of one raw chunk (span || payload), as Bee computes it. */
export function contentAddress(chunk: Uint8Array): string {
  return hex(hash(concat(chunk.subarray(0, 8), bmtRoot(chunk.subarray(8)))));
}

function chunkAddress(span: bigint, payload: Uint8Array): Uint8Array {
  const spanBytes = new Uint8Array(8);
  new DataView(spanBytes.buffer).setBigUint64(0, span, true);
  return hash(concat(spanBytes, bmtRoot(payload)));
}

/** The 64-hex Swarm reference of unencrypted bytes, as returned by Bee's POST /bytes. */
export function swarmAddress(data: Uint8Array): string {
  if (data.length <= CHUNK_SIZE) return hex(chunkAddress(BigInt(data.length), data));
  let level: { address: Uint8Array; span: bigint }[] = [];
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    const payload = data.subarray(i, i + CHUNK_SIZE);
    level.push({ address: chunkAddress(BigInt(payload.length), payload), span: BigInt(payload.length) });
  }
  while (level.length > 1) {
    const next: typeof level = [];
    for (let i = 0; i < level.length; i += BRANCHES) {
      const group = level.slice(i, i + BRANCHES);
      if (group.length === 1) {
        next.push(group[0]);
        continue;
      }
      const span = group.reduce((a, c) => a + c.span, 0n);
      next.push({ address: chunkAddress(span, concat(...group.map((c) => c.address))), span });
    }
    level = next;
  }
  return hex(level[0].address);
}

/** Every chunk of unencrypted bytes by address, as Bee stores them (span || payload), with no erasure coding. */
export function swarmChunks(data: Uint8Array): { reference: string; chunks: Map<string, Uint8Array> } {
  const chunks = new Map<string, Uint8Array>();
  const put = (span: bigint, payload: Uint8Array) => {
    const spanBytes = new Uint8Array(8);
    new DataView(spanBytes.buffer).setBigUint64(0, span, true);
    const address = chunkAddress(span, payload);
    chunks.set(hex(address), concat(spanBytes, payload));
    return address;
  };
  let level: { address: Uint8Array; span: bigint }[] = [];
  for (let i = 0; i < Math.max(data.length, 1); i += CHUNK_SIZE) {
    const payload = data.subarray(i, i + CHUNK_SIZE);
    level.push({ address: put(BigInt(payload.length), payload), span: BigInt(payload.length) });
  }
  while (level.length > 1) {
    const next: typeof level = [];
    for (let i = 0; i < level.length; i += BRANCHES) {
      const group = level.slice(i, i + BRANCHES);
      if (group.length === 1) {
        next.push(group[0]);
        continue;
      }
      const span = group.reduce((a, c) => a + c.span, 0n);
      next.push({ address: put(span, concat(...group.map((c) => c.address))), span });
    }
    level = next;
  }
  return { reference: hex(level[0].address), chunks };
}

/**
 * Rebuilds the bytes under a 64-hex reference from raw chunks, checking every chunk against
 * its own address on the way down, so a gateway can't swap the content. Intermediate chunks
 * may be erasure-coded (the span's top byte then holds the redundancy level, and parity
 * references follow the data ones); data children are read in order until their sizes add up
 * to the span, so parity chunks are never needed.
 */
export async function verifiedJoin(reference: string, getChunk: (address: string) => Promise<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const walk = async (address: string, depth: number): Promise<bigint> => {
    if (depth > 8) throw new Error("Swarm tree is too deep");
    const chunk = await getChunk(address);
    if (chunk.length < 8 || chunk.length > 8 + CHUNK_SIZE) throw new Error(`Swarm chunk ${address.slice(0, 12)}… has a bad size`);
    const spanBytes = chunk.subarray(0, 8);
    const payload = chunk.subarray(8);
    if (hex(hash(concat(spanBytes, bmtRoot(payload)))) !== address) throw new Error(`Swarm chunk ${address.slice(0, 12)}… does not match its address`);
    const raw = new Uint8Array(spanBytes);
    if (raw[7] & 0x80) raw[7] = 0;
    const size = new DataView(raw.buffer).getBigUint64(0, true);
    if (size <= BigInt(CHUNK_SIZE)) {
      if (BigInt(payload.length) !== size) throw new Error(`Swarm chunk ${address.slice(0, 12)}… is not the size its span says`);
      parts.push(payload);
      return size;
    }
    let got = 0n;
    for (let i = 0; i + SEGMENT <= payload.length && got < size; i += SEGMENT) got += await walk(hex(payload.subarray(i, i + SEGMENT)), depth + 1);
    if (got !== size) throw new Error(`Swarm chunk ${address.slice(0, 12)}…: children add up to ${got} bytes, not ${size}`);
    return size;
  };
  await walk(reference.toLowerCase(), 0);
  return concat(...parts);
}

const hash = (b: Uint8Array) => keccak256(b, "bytes");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
