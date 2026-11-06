import type { LocalAccount } from "viem";
import type { NetworkConfig } from "../config.js";
import { swarmChunks, verifiedJoin } from "./swarm-bmt.js";
import { feedTopic, feedUpdateAddress, makeFeedUpdate, readFeedUpdate } from "./swarm-feed.js";
import { PostageStamper } from "./swarm-stamper.js";
import { accountOf } from "../util/sign.js";
import { logger } from "../util/log.js";
import { withRetry as retry } from "../util/http.js";

const withRetry = (what: string, call: () => Promise<Response>) => retry(what, call, ATTEMPTS);

// Swarm via the Bee node HTTP API (by default the public gateway).
//
// Uploads are plain /bytes with 64-hex references. Chunk data is already AES-GCM sealed before
// upload, and its reference is sealed again before it goes into a public Arkiv entity, so
// Swarm-layer encryption adds nothing, and its 128-hex references carry their own decryption
// key: the docs say never to send those to a public gateway. SWARM_ENCRYPT=true is honoured
// only on your own Bee node.
//
// Downloads don't trust the gateway. A 64-hex reference is fetched chunk by chunk and every
// chunk is checked against its content address. Older 128-hex references still download (by
// /bytes; Bee decrypts), and everything KINETIC stored under one is AES-GCM sealed, so a changed
// byte fails to decrypt.
//
// Storage: the public gateway stamps uploads with its own batch and keeps them only for a
// while; it ignores swarm-postage-batch-id (a batch is usable only on the node that owns it).
// With BEE_POSTAGE_BATCH_ID plus SWARM_STAMP_KEY (the batch owner's key) and BEE_POSTAGE_DEPTH,
// uploads are split and stamped here, chunk by chunk, and the gateway forwards the stamps
// (swarm-postage-stamp on /chunks and /soc). On your own Bee node, BEE_POSTAGE_BATCH_ID alone
// is enough. See docs/SWARM_STAMP.md.
//
// Passports are uploaded with erasure coding (swarm-redundancy-level), and a model's newest
// Model Passport is published on a feed, whose manifest gives it a stable /bzz URL.
//
// The public gateway drops connections now and then, so every call is retried with backoff
// on network errors, timeouts, 429 and 5xx. A wrong answer is never retried into a right one:
// content that fails its check is an error, not a retry.

const ATTEMPTS = 4;
const TIMEOUT_MS = 30_000;
const PARALLEL = 8;

/** A public gateway: never send it a Swarm-encrypted reference, and it ignores batch ids. */
export const isPublicGateway = (url: string) => /(^|\.)gateway\.ethswarm\.org/i.test(new URL(url).hostname);

/** Where a feed is and its newest update, as KINETIC records it. */
export interface FeedInfo {
  owner: string;
  topic: string;
  /** Index of the update just written. */
  index: number;
  /** What the update points at. */
  target: string;
  /** Feed manifest: /bzz/{manifest}/ always serves what the newest update points at. */
  manifest: string;
}

export class SwarmClient {
  private readonly log = logger("swarm");
  private readonly stamper?: PostageStamper;
  private warned = new Set<string>();
  /** Highest index written per feed, as the gateway's lookup lags a few seconds behind. */
  private readonly feedIndex = new Map<string, number>();
  private feedQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cfg: NetworkConfig["swarm"],
    opts: { stampStateFile?: string } = {},
  ) {
    if (cfg.postageBatchId && cfg.stampKey) {
      if (!cfg.postageDepth) throw new Error("SWARM_STAMP_KEY needs BEE_POSTAGE_DEPTH, the batch's depth");
      this.stamper = new PostageStamper(accountOf(cfg.stampKey), cfg.postageBatchId.replace(/^0x/, ""), cfg.postageDepth, opts.stampStateFile);
    }
  }

  private warnOnce(key: string, message: string) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log(message);
  }

  /** Headers that pay for an upload the gateway builds itself (not chunk by chunk here). */
  private postageHeaders(): Record<string, string> {
    if (!this.cfg.postageBatchId || this.stamper) return {};
    if (isPublicGateway(this.cfg.beeUrl)) {
      this.warnOnce("batch", "BEE_POSTAGE_BATCH_ID is ignored by the public gateway (it stamps with its own batch); set SWARM_STAMP_KEY and BEE_POSTAGE_DEPTH to stamp uploads here");
    }
    return { "swarm-postage-batch-id": this.cfg.postageBatchId };
  }

  /**
   * Uploads bytes; returns the reference. `redundancy`: erasure-coding level 0–4 (passports).
   * `encrypt` (or SWARM_ENCRYPT) is refused on a public gateway: the upload goes up plain.
   */
  async upload(data: Uint8Array, opts: { encrypt?: boolean; redundancy?: number } = {}): Promise<string> {
    let encrypt = opts.encrypt ?? this.cfg.encrypt;
    // Reads through a public gateway (SWARM_GATEWAY_URL) would hand it the key too, even when uploads go to our own node.
    if (encrypt && (isPublicGateway(this.cfg.beeUrl) || isPublicGateway(this.cfg.gatewayUrl) || this.stamper)) {
      this.warnOnce("encrypt", this.stamper ? "Swarm encryption is off with client-side stamps (uploads are split here, unencrypted; chunks are AES-GCM sealed anyway)" : "Swarm encryption is off on the public gateway: a 128-hex reference would hand it the decryption key (chunks are AES-GCM sealed anyway)");
      encrypt = false;
    }
    if (this.stamper) return this.uploadStamped(data);
    const headers: Record<string, string> = { "content-type": "application/octet-stream", ...this.postageHeaders() };
    if (encrypt) headers["swarm-encrypt"] = "true";
    if (opts.redundancy) headers["swarm-redundancy-level"] = String(opts.redundancy);
    const res = await withRetry("swarm upload", () => fetch(`${this.cfg.beeUrl}/bytes`, { method: "POST", headers, body: new Uint8Array(data), signal: AbortSignal.timeout(TIMEOUT_MS) }));
    if (!res.ok) throw new Error(`swarm upload failed (${res.status}): ${await res.text()}`);
    const { reference } = (await res.json()) as { reference: string };
    return reference;
  }

  /**
   * Splits the data here and uploads every chunk to /chunks with our own postage stamp. No
   * erasure coding: Bee adds parity only when it splits the data itself.
   */
  private async uploadStamped(data: Uint8Array): Promise<string> {
    const { reference, chunks } = swarmChunks(data);
    const entries = [...chunks];
    const stamps = await this.stamper!.stamp(entries.map(([address]) => address));
    for (let i = 0; i < entries.length; i += PARALLEL) {
      await Promise.all(
        entries.slice(i, i + PARALLEL).map(async ([address, chunk], j) => {
          const res = await withRetry("swarm chunk upload", () =>
            fetch(`${this.cfg.beeUrl}/chunks`, {
              method: "POST",
              headers: { "content-type": "application/octet-stream", "swarm-postage-stamp": stamps[i + j] },
              body: new Uint8Array(chunk),
              signal: AbortSignal.timeout(TIMEOUT_MS),
            }),
          );
          if (!res.ok) throw new Error(`swarm chunk upload failed (${res.status}): ${await res.text()}`);
          const got = ((await res.json()) as { reference: string }).reference;
          if (got !== address) throw new Error(`swarm stored chunk ${address.slice(0, 12)}… as ${got.slice(0, 12)}…`);
        }),
      );
    }
    return reference;
  }

  /** Uploads one file as a /bzz manifest (so /bzz/{ref}/ serves it with its content type). */
  async uploadFile(data: Uint8Array, name: string, contentType: string, opts: { redundancy?: number } = {}): Promise<string> {
    const headers: Record<string, string> = { "content-type": contentType, ...this.postageHeaders() };
    if (opts.redundancy) headers["swarm-redundancy-level"] = String(opts.redundancy);
    const res = await withRetry("swarm file upload", () => fetch(`${this.cfg.beeUrl}/bzz?name=${encodeURIComponent(name)}`, { method: "POST", headers, body: new Uint8Array(data), signal: AbortSignal.timeout(TIMEOUT_MS) }));
    if (!res.ok) throw new Error(`swarm file upload failed (${res.status}): ${await res.text()}`);
    return ((await res.json()) as { reference: string }).reference;
  }

  async download(reference: string): Promise<Uint8Array> {
    if (/^[0-9a-f]{64}$/i.test(reference)) return verifiedJoin(reference, (address) => this.chunk(address));
    const res = await withRetry("swarm download", () => fetch(`${this.cfg.gatewayUrl}/bytes/${reference}`, { signal: AbortSignal.timeout(TIMEOUT_MS) }));
    if (!res.ok) throw new Error(`swarm download failed (${res.status}) for ${reference.slice(0, 12)}…`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** One raw chunk (span || payload, or a whole SOC), unchecked: callers check it against its address. */
  private async chunk(address: string): Promise<Uint8Array> {
    const res = await withRetry("swarm chunk download", () => fetch(`${this.cfg.gatewayUrl}/chunks/${address}`, { signal: AbortSignal.timeout(TIMEOUT_MS) }));
    if (!res.ok) throw new Error(`swarm download failed (${res.status}) for chunk ${address.slice(0, 12)}…`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Points the feed `topicName` of `account` at `target` with a new signed update, and makes
   * sure its feed manifest exists. Writes to one client's feeds go one at a time. `after`: the
   * last index this caller knows was written (the gateway's lookup can lag behind).
   */
  publishFeed(account: LocalAccount, topicName: string, target: string, after = -1): Promise<FeedInfo> {
    const run = this.feedQueue.then(() => this.publishFeedNow(account, topicName, target, after));
    this.feedQueue = run.catch(() => undefined);
    return run;
  }

  private async publishFeedNow(account: LocalAccount, topicName: string, target: string, after: number): Promise<FeedInfo> {
    const owner = account.address.slice(2).toLowerCase();
    const topic = feedTopic(topicName);
    const key = `${owner}/${topic}`;
    const latest = await this.feedLatestIndex(owner, topic);
    const index = Math.max(latest + 1, after + 1, (this.feedIndex.get(key) ?? -1) + 1);
    const soc = await makeFeedUpdate(account, topic, index, target);
    const headers: Record<string, string> = { "content-type": "application/octet-stream" };
    if (this.stamper) headers["swarm-postage-stamp"] = (await this.stamper.stamp([soc.address]))[0];
    else Object.assign(headers, this.postageHeaders());
    const res = await withRetry("swarm feed update", () =>
      fetch(`${this.cfg.beeUrl}/soc/${soc.owner}/${soc.identifier}?sig=${soc.signature}`, { method: "POST", headers, body: new Uint8Array(soc.data), signal: AbortSignal.timeout(TIMEOUT_MS) }),
    );
    if (!res.ok) throw new Error(`swarm feed update failed (${res.status}): ${await res.text()}`);
    const got = ((await res.json()) as { reference: string }).reference;
    if (got !== soc.address) throw new Error(`swarm stored the feed update as ${got.slice(0, 12)}…, not ${soc.address.slice(0, 12)}…`);
    this.feedIndex.set(key, index);
    // The manifest only names the owner and topic, so it is the same every time: re-posting it
    // keeps it stored. Bee builds it server-side, so it can't carry our own stamp.
    const m = await withRetry("swarm feed manifest", () => fetch(`${this.cfg.beeUrl}/feeds/${owner}/${topic}`, { method: "POST", headers: this.postageHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) }));
    if (!m.ok) throw new Error(`swarm feed manifest failed (${m.status}): ${await m.text()}`);
    const manifest = ((await m.json()) as { reference: string }).reference;
    return { owner, topic, index, target, manifest };
  }

  /** The newest index of a feed as the gateway sees it, or -1 when it has none. */
  private async feedLatestIndex(owner: string, topic: string): Promise<number> {
    const res = await withRetry("swarm feed lookup", () => fetch(`${this.cfg.gatewayUrl}/feeds/${owner}/${topic}`, { headers: { "swarm-only-root-chunk": "true" }, signal: AbortSignal.timeout(TIMEOUT_MS) }));
    if (res.status === 404) return -1;
    if (!res.ok) throw new Error(`swarm feed lookup failed (${res.status}): ${await res.text()}`);
    await res.arrayBuffer();
    const index = res.headers.get("swarm-feed-index");
    if (!index) throw new Error("swarm feed lookup answered without swarm-feed-index");
    return Number(BigInt(`0x${index}`));
  }

  /**
   * A feed's newest update, checked here: the gateway only says which index is newest; the
   * update itself must be signed by `owner` and is read from its own address.
   */
  async readFeed(owner: string, topicName: string): Promise<{ index: number; reference: string; timestamp: number } | undefined> {
    const o = owner.replace(/^0x/, "").toLowerCase();
    const topic = feedTopic(topicName);
    const index = await this.feedLatestIndex(o, topic);
    if (index < 0) return undefined;
    const update = await readFeedUpdate(await this.chunk(feedUpdateAddress(o, topic, index)), o, topic, index);
    return { index, ...update };
  }

  /** Public URL for a reference, for links in the dashboard and README. */
  url(reference: string): string {
    return `${this.cfg.gatewayUrl}/bytes/${reference}`;
  }

  /** Stable URL of a feed manifest: always the newest thing the feed points at. */
  feedUrl(manifest: string): string {
    return `${this.cfg.gatewayUrl}/bzz/${manifest}/`;
  }
}
