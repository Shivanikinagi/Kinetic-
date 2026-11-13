import "../src/env.js";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { verifyPassport, type Passport } from "../src/agent/passport.js";
import { loadNetworkConfig } from "../src/config.js";
import { isStorageRef } from "../src/integrations/storage-ref.js";
import { ZgStorageClient } from "../src/integrations/zg-storage.js";
import type { ItemOutput } from "../src/types.js";

// Checks a KINETIC Compute Passport. Anyone can run it; it needs no keys.
//
//   npm run passport:verify -- <0G Storage root | passport.json> [--results out/<jobId>.json] [--offline]
//
// Offline it checks the signatures, the canary commit/reveal, every provider's signed result
// hash and each canary's 0G TEE signature (EIP-191, against the signer recorded with it).
// Online (the default) it also finds the job's receipts on HCS, the payments on the mirror
// node, the slashes in the vault, and each canary's TEE signer in 0G's serving contract (0G
// mainnet, where the router's providers are registered; --zg-rpc overrides).
// Hedera: offline it rebuilds the job's Merkle root from its chunks and checks each chunk's proof,
// and re-derives the PRNG spot-check picks from their seed; online it finds the job's
// `hcs.merkleRootAnchor` message on HCS and the spot-check seed the vault recorded after the reveal.

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    results: { type: "string" },
    offline: { type: "boolean", default: false },
    // The 0G Storage indexer to fetch the passport through (default: the configured one).
    indexer: { type: "string", default: "" },
    // The passport names its own mirror node; only an explicit flag overrides it (not .env,
    // which may point at another network).
    mirror: { type: "string", default: "" },
    "zg-rpc": { type: "string", default: "" },
  },
});

const target = positionals[0];
if (!target) {
  console.error("usage: npm run passport:verify -- <0G Storage root | passport.json> [--results out/<jobId>.json] [--offline]");
  process.exit(2);
}

async function load(): Promise<Passport> {
  if (existsSync(target)) return JSON.parse(readFileSync(target, "utf8"));
  if (!isStorageRef(target)) throw new Error(`${target} is neither a file nor a 0G Storage root (0x + 64 hex)`);
  const indexer = values.indexer || loadNetworkConfig().zgStorage.indexerUrl;
  // The client recomputes the 0G Merkle root from the bytes it gets: the indexer can't hand back a different passport.
  const bytes = await new ZgStorageClient({ indexerUrl: indexer, rpcUrl: "" }).download(target);
  console.log(`  ✓ passport bytes match 0G Storage root ${target.slice(0, 18)}…`);
  return JSON.parse(new TextDecoder().decode(bytes)) as Passport;
}

const passport = await load();
// A job report (out/<jobId>.json) holds its results under `results`; a bare array works too.
const results = values.results ? ((raw) => (Array.isArray(raw) ? raw : raw.results) as ItemOutput[])(JSON.parse(readFileSync(values.results, "utf8"))) : undefined;

console.log(`\n  Compute Passport ${passport.jobId} (${passport.network})`);
console.log(`  ${passport.completed}/${passport.chunks} chunks · ${passport.coverage.verified} checked against 0G (${Math.round(passport.coverage.share * 100)}%) · ${passport.providers.filter((p) => p.status === "slashed").length} slashed\n`);

const checks = await verifyPassport(passport, { results, online: !values.offline, mirrorUrl: values.mirror || undefined, zgTeeRpcUrl: values["zg-rpc"] || undefined });
for (const c of checks) {
  const mark = c.ok === null ? "-" : c.ok ? "✓" : "✗";
  console.log(`  ${mark} ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
}

console.log("\n  What this passport does not prove:");
for (const l of passport.limitations) console.log(`    · ${l}`);

const failed = checks.filter((c) => c.ok === false);
console.log(failed.length ? `\n  ${failed.length} check${failed.length === 1 ? "" : "s"} failed.\n` : "\n  All checks passed.\n");
process.exit(failed.length ? 1 : 0);
