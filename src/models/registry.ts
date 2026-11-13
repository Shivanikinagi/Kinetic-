import { attrBig, attrStr, type ArkivStore, type Attrs, type StoredEntity } from "../integrations/arkiv.js";
import type { DocumentStore } from "../integrations/storage.js";
import { compareVersions, isModelKey, parseModelRef, type ModelCard } from "./card.js";
import { modelPassportDigest, type ModelPassport } from "./passport.js";

// The model registry is a set of Arkiv entities of kind `model`. Only a verifier in the bond
// vault's verifier set can list a model (it writes the entity after a quorum signed the Model
// Passport), so a listing is trusted only when its owner is one of those verifiers. The entity
// expires like any Arkiv entity; the verifier that listed it renews it, and the passport itself
// stays on 0G Storage with its digest on HCS, so an expired listing can always be restored.

export interface ModelListing {
  key: string;
  id: string;
  version: string;
  name: string;
  card: ModelCard;
  passportRef: string;
  passportDigest: string;
  /** Benchmark accuracy, 0..1. */
  accuracy: number;
  /** Parameters read from the safetensors headers, when the weights were checked. */
  params?: number;
  /** Whether the weights went through the malware checks (false for 0G-served models). */
  weightsChecked: boolean;
  /** The verifiers whose signatures carried the passport. */
  signers: string[];
  /** The verifier that wrote the listing (its Arkiv owner). */
  listedBy: string;
  entityKey: string;
}

export interface ListingPayload {
  card: ModelCard;
  passportRef: string;
  passportDigest: string;
  accuracy: number;
  params?: number;
  weightsChecked: boolean;
  signers: string[];
}

/** The attributes a listing is queried by. */
export function listingAttrs(key: string, p: ListingPayload): Attrs {
  return {
    mkey: key,
    model_id: p.card.id.slice(0, 120),
    version: p.card.version.slice(0, 40),
    name: p.card.name.slice(0, 80),
    creator: p.card.creator.address,
    royalty_bps: p.card.royaltyBps,
    accuracy: Math.round(p.accuracy * 100),
    engine: p.card.runtime.engine,
    passport_ref: p.passportRef,
    passport_digest: p.passportDigest,
    status: "listed",
    [`task.${p.card.task.kind}`]: 1,
  };
}

export function listingFromEntity(e: StoredEntity): ModelListing | null {
  const p = e.payload as Partial<ListingPayload> | null;
  const key = attrStr(e, "mkey");
  if (!p?.card || !isModelKey(key) || !p.passportRef || !p.passportDigest) return null;
  if (p.card.id !== attrStr(e, "model_id") || p.card.version !== attrStr(e, "version")) return null;
  return {
    key,
    id: p.card.id,
    version: p.card.version,
    name: p.card.name,
    card: p.card,
    passportRef: p.passportRef,
    passportDigest: p.passportDigest,
    accuracy: Number(attrBig(e, "accuracy")) / 100,
    ...(p.params !== undefined ? { params: p.params } : {}),
    weightsChecked: !!p.weightsChecked,
    signers: p.signers ?? [],
    listedBy: e.owner,
    entityKey: e.key,
  };
}

/** Listings written by the vault's verifiers, one per model version (the newest entity wins). */
export async function findModels(arkiv: ArkivStore, verifiers: string[], filter: { key?: string; id?: string; version?: string } = {}): Promise<ModelListing[]> {
  const where: Attrs = { status: "listed", ...(filter.key ? { mkey: filter.key } : {}), ...(filter.id ? { model_id: filter.id } : {}), ...(filter.version ? { version: filter.version } : {}) };
  const allowed = new Set(verifiers.map((v) => v.toLowerCase()));
  // Created by one of the vault's verifiers (the creator never changes) and still owned by one.
  const entities = (await arkiv.query("model", where, { limit: 500 })).filter((e) => allowed.has(e.owner) && allowed.has(e.creator ?? e.owner));
  const newest = new Map<string, StoredEntity>();
  for (const e of entities) {
    const k = attrStr(e, "mkey");
    const seen = newest.get(k);
    if (!seen || (e.expiresAt ?? 0n) > (seen.expiresAt ?? 0n)) newest.set(k, e);
  }
  return [...newest.values()]
    .map(listingFromEntity)
    .filter((l): l is ModelListing => l !== null)
    .sort((a, b) => a.id.localeCompare(b.id) || compareVersions(b.version, a.version));
}

/** Several models at once, with one registry query: `resolveModel` for each ref, in order. */
export async function resolveModels(arkiv: ArkivStore, verifiers: string[], refs: string[]): Promise<ModelListing[]> {
  const all = await findModels(arkiv, verifiers);
  return refs.map((ref) => {
    if (isModelKey(ref)) {
      const hit = all.find((l) => l.key === ref);
      if (!hit) throw new Error(`no listed model with key ${ref}`);
      return hit;
    }
    const { id, version } = parseModelRef(ref);
    const found = all.filter((l) => l.id === id && (!version || l.version === version));
    if (found.length === 0) throw new Error(`no listed model ${ref}`);
    return found.sort((a, b) => compareVersions(b.version, a.version))[0]!;
  });
}

/** A model by key, "id@version" or "id" (the newest version). */
export async function resolveModel(arkiv: ArkivStore, verifiers: string[], ref: string): Promise<ModelListing> {
  if (isModelKey(ref)) {
    const [hit] = await findModels(arkiv, verifiers, { key: ref });
    if (!hit) throw new Error(`no listed model with key ${ref}`);
    return hit;
  }
  const { id, version } = parseModelRef(ref);
  const found = await findModels(arkiv, verifiers, { id, ...(version ? { version } : {}) });
  if (found.length === 0) throw new Error(`no listed model ${ref}`);
  return found.sort((a, b) => compareVersions(b.version, a.version))[0];
}

/** Downloads a listing's Model Passport from 0G Storage and checks it is the one the listing names. */
export async function loadModelPassport(storage: DocumentStore, listing: Pick<ModelListing, "passportRef" | "passportDigest" | "key">): Promise<ModelPassport> {
  const passport = JSON.parse(new TextDecoder().decode(await storage.download(listing.passportRef))) as ModelPassport;
  if (modelPassportDigest(passport) !== listing.passportDigest) throw new Error(`the Model Passport on 0G Storage for ${listing.key} doesn't match its listing`);
  if (passport.key !== listing.key) throw new Error(`the Model Passport on 0G Storage is for ${passport.key}, not ${listing.key}`);
  return passport;
}
