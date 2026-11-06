import { recoverMessageAddress, type Hex } from "viem";
import type { ModelListing, ModelPassport } from "./data";
import { feedTopic, fetchVerified, latestFeedUpdate, modelPassportTopicName } from "./swarm";

// Model Passports, checked in the browser: the same digests and signatures the verifiers sign,
// recomputed here with WebCrypto and viem, so the page doesn't take the server's word for it.

export interface BrowserCheck {
  name: string;
  /** null: doesn't apply (e.g. no published weights). */
  ok: boolean | null;
  detail?: string;
}

/** The same canonical JSON the backend hashes: sorted keys, undefined dropped. */
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

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signer(message: string, signature: string): Promise<string | null> {
  try {
    return (await recoverMessageAddress({ message, signature: signature as Hex })).toLowerCase();
  } catch {
    return null;
  }
}

export async function verifyPassportInBrowser(p: ModelPassport, listing: ModelListing, quorum: { verifiers: string[]; threshold: number } | undefined): Promise<BrowserCheck[]> {
  const checks: BrowserCheck[] = [];
  const { attestations, ...body } = p;
  const digest = await sha256Hex(canonicalJson(body));
  checks.push({ name: "Passport is the one the listing names", ok: digest === listing.passportDigest, detail: `sha256 ${digest.slice(0, 12)}…` });
  const key = `m${(await sha256Hex(`${p.card.id}@${p.card.version}`)).slice(0, 15)}`;
  checks.push({ name: "Key names this model and version", ok: key === p.key && key === listing.key, detail: key });
  const cardDigest = await sha256Hex(canonicalJson(p.card));
  checks.push({ name: "Card digest matches the card", ok: cardDigest === p.cardDigest });
  const creator = await signer(`kinetic.model.v1:${cardDigest}`, p.creatorSignature);
  checks.push({ name: "Signed by the creator", ok: creator === p.card.creator.address, detail: creator ?? "no valid signature" });
  if (p.weights.checked) {
    const failed = p.weights.checks.filter((c) => !c.ok);
    checks.push({ name: "Malware checks passed", ok: p.weights.ok && failed.length === 0, detail: failed.length ? failed.map((c) => c.name).join("; ") : `${p.weights.files.length} files, ${p.weights.params.toLocaleString("en-US")} parameters` });
    const listed = new Map((p.card.weights?.files ?? []).map((f) => [f.name, f.sha256]));
    checks.push({ name: "Scanned files are exactly the card's", ok: p.weights.files.length === listed.size && p.weights.files.every((f) => listed.get(f.name) === f.sha256) });
  } else {
    checks.push({ name: "Malware checks", ok: null, detail: p.weights.reason });
  }
  const b = p.benchmark;
  checks.push({ name: "Benchmark clears the listing bar", ok: b.items > 0 && b.accuracy >= b.minAccuracy, detail: `${b.correct}/${b.items} (${Math.round(b.accuracy * 100)}%), bar ${Math.round(b.minAccuracy * 100)}%` });
  const allowed = new Set((quorum?.verifiers ?? []).map((v) => v.toLowerCase()));
  const good = new Set<string>();
  for (const a of attestations?.verifiers ?? []) {
    const who = await signer(`kinetic.model-passport.v1:${digest}`, a.signature);
    if (who && who === a.address.toLowerCase() && allowed.has(who)) good.add(who);
  }
  checks.push({
    name: "Signed by a quorum of the vault's verifiers",
    ok: quorum ? good.size >= quorum.threshold : null,
    detail: quorum ? `${good.size} signed, ${quorum.threshold} needed` : "verifier set unknown",
  });
  return checks;
}

const passportDigestOf = async (p: ModelPassport) => {
  const { attestations: _a, ...body } = p;
  return sha256Hex(canonicalJson(body));
};

/**
 * The passport straight from Swarm, not from the verifier's API: every chunk checked against
 * the listing's reference (BMT), and the bytes are the passport the listing names.
 */
export async function verifyPassportOnSwarm(gateway: string, listing: ModelListing): Promise<BrowserCheck> {
  const name = "Passport on Swarm matches its address and the listing";
  try {
    const bytes = await fetchVerified(gateway, listing.passportRef);
    const digest = await passportDigestOf(JSON.parse(new TextDecoder().decode(bytes)) as ModelPassport);
    return { name, ok: digest === listing.passportDigest, detail: `${bytes.length.toLocaleString("en-US")} bytes, every chunk checked` };
  } catch (err) {
    return { name, ok: false, detail: (err as Error).message };
  }
}

export interface PassportFeedCheck {
  check: BrowserCheck;
  /** The listing the feed's newest update points at, when it is a listed passport. */
  latest?: ModelListing;
  /** Stable URL of the model's newest passport (the feed manifest). */
  url?: string;
}

/**
 * The model's passport feed: its newest update is signed by a vault verifier (checked here from
 * the single-owner chunk) and points at a passport the registry lists for this model.
 */
export async function verifyPassportFeed(gateway: string, listing: ModelListing, listings: ModelListing[], verifiers: string[]): Promise<PassportFeedCheck> {
  const name = "Newest passport, from the model's signed feed";
  const feed = listing.feed;
  if (!feed) return { check: { name, ok: null, detail: "this listing has no feed" } };
  const url = `${gateway}/bzz/${feed.manifest}/`;
  try {
    const topic = feedTopic(modelPassportTopicName(listing.card.id));
    if (topic !== feed.topic) return { url, check: { name, ok: false, detail: "feed topic isn't this model's" } };
    if (!verifiers.map((v) => v.toLowerCase().replace(/^0x/, "")).includes(feed.owner.toLowerCase())) return { url, check: { name, ok: false, detail: `feed owner 0x${feed.owner} isn't a vault verifier` } };
    const update = await latestFeedUpdate(gateway, feed.owner, topic);
    if (!update) return { url, check: { name, ok: false, detail: "no update found" } };
    const res = await fetch(`${gateway}/bzz/${update.reference}/`);
    if (!res.ok) return { url, check: { name, ok: false, detail: `newest passport: gateway answered ${res.status}` } };
    const digest = await passportDigestOf((await res.json()) as ModelPassport);
    const latest = listings.find((l) => l.card.id === listing.card.id && l.passportDigest === digest);
    if (!latest) return { url, check: { name, ok: false, detail: `update ${update.index} points at a passport the registry doesn't list` } };
    const when = new Date(update.timestamp * 1000).toISOString().slice(0, 16).replace("T", " ");
    return {
      url,
      latest,
      check: { name, ok: true, detail: `update ${update.index} (${when} UTC), signed by 0x${update.signer.slice(0, 8)}…: ${latest.key === listing.key ? "this version" : `v${latest.card.version}`}` },
    };
  } catch (err) {
    return { url, check: { name, ok: false, detail: (err as Error).message } };
  }
}
