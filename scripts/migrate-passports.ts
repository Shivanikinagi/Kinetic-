import "../src/env.js";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { identityFromEnv, loadNetworkConfig } from "../src/config.js";
import { connect } from "../src/integrations/index.js";
import { TTL } from "../src/integrations/arkiv.js";
import { isStorageRef } from "../src/integrations/storage.js";
import { modelPassportDigest, type ModelPassport } from "../src/models/passport.js";
import { listingAttrs, type ListingPayload } from "../src/models/registry.js";
import { loadRoleEnv } from "../src/testnet/roles.js";
import { stateFile, writeJsonAtomic } from "../src/util/state.js";
import type { ListingRecord } from "../src/verifier/models.js";

// One-time move of Model Passports to 0G Storage (2026-11-11), from where KINETIC kept them before.
//
//   npm run migrate:passports            # dry run: reads every passport and checks it, changes nothing
//   npm run migrate:passports -- --apply # stores each on 0G, then points its listing (Arkiv + verifier state) at it
//
// Stop `npm run live` first: the verifier keeps its listings in memory and would write them back.
// For each listing whose passport isn't on 0G Storage yet, it reads the passport once over plain
// HTTPS from the public gateway it was published through, checks its digest against the listing
// (the digest every verifier signed, also on HCS), and stores the same bytes on 0G Storage, paid
// from the verifier's 0G wallet. Signatures cover the passport body, not where it's stored, so they
// still check. HCS `model` receipts are history and keep the old reference; their digest is unchanged.

const { values } = parseArgs({ options: { apply: { type: "boolean", default: false }, gateway: { type: "string", default: "https://api.gateway.ethswarm.org" } } });

const env = loadRoleEnv("verifier");
const cfg = loadNetworkConfig(env);
const svc = connect(cfg, identityFromEnv(env));
const file = stateFile(cfg, `verifier-${svc.address}`, "models.json");
if (!file || !existsSync(file)) throw new Error(`no verifier listings at ${file ?? "(no state dir)"}`);

// The verifier must be stopped, or it would overwrite this with its in-memory copy.
const running = await fetch("http://localhost:4500/status", { signal: AbortSignal.timeout(2000) }).then(
  () => true,
  () => false,
);
if (running && values.apply) throw new Error("the verifier is running on :4500: stop `npm run live` first, then run this again");

const records = JSON.parse(readFileSync(file, "utf8")) as (ListingRecord & { feed?: unknown })[];
const legacy = records.filter((r) => !isStorageRef(r.passportRef));
console.log(`\n  ${records.length} listings, ${legacy.length} with a passport not on 0G Storage yet${values.apply ? "" : " (dry run: nothing changes)"}\n`);

let moved = 0;
for (const r of legacy) {
  const label = `${r.card.id}@${r.card.version} (${r.key})`;
  try {
    const res = await fetch(`${values.gateway.replace(/\/$/, "")}/bytes/${r.passportRef}`, { signal: AbortSignal.timeout(90_000) });
    if (!res.ok) throw new Error(`the gateway answered ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const passport = JSON.parse(new TextDecoder().decode(bytes)) as ModelPassport;
    if (modelPassportDigest(passport) !== r.passportDigest || passport.key !== r.key) throw new Error("the passport doesn't match the digest its listing names");
    if (!values.apply) {
      console.log(`  ✓ ${label}: passport read and checked (${bytes.length} bytes)`);
      continue;
    }
    const root = await svc.storage.upload(bytes);
    // Same bytes back from 0G before anything points at them.
    if (modelPassportDigest(JSON.parse(new TextDecoder().decode(await svc.storage.download(root))) as ModelPassport) !== r.passportDigest) throw new Error("0G Storage returned a different passport");
    const { key: _k, entityKey: _e, fingerprint: _f, issuedAt: _i, renewedAt: _r, arkivChainId: _c, feed: _feed, ...rest } = r;
    const payload: ListingPayload = { ...rest, passportRef: root };
    try {
      await svc.arkiv.patch(r.entityKey, listingAttrs(r.key, payload), payload);
    } catch (err) {
      if (!/expired|not ?found|no ?entity|does not exist/i.test((err as Error).message)) throw err;
      r.entityKey = await svc.arkiv.create({ kind: "model", ttlSeconds: TTL.model, attrs: listingAttrs(r.key, payload), payload });
    }
    r.passportRef = root;
    delete r.feed;
    r.renewedAt = Date.now();
    writeJsonAtomic(file, records);
    moved += 1;
    console.log(`  ✓ ${label}: stored on 0G Storage at ${root}`);
  } catch (err) {
    console.log(`  ✗ ${label}: ${(err as Error).message}`);
  }
}
await svc.arkiv.flush();
// Listings already on 0G may still carry the old feed field: drop it.
if (values.apply && records.some((r) => r.feed)) {
  for (const r of records) delete r.feed;
  writeJsonAtomic(file, records);
}
console.log(values.apply ? `\n  ${moved} of ${legacy.length} moved to 0G Storage.\n` : `\n  Dry run done. Run with --apply to move them.\n`);
process.exit(0);
