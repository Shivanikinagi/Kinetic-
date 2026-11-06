# Arkiv schema

KINETIC writes these kinds of entity to Arkiv Rabdi (chain 7794095) with `@arkiv-network/sdk` 1.0. Each kind is written through its own named schema, `kinetic.<kind>` (`kinetic.offer`, `kinetic.job`, …), which tags every entity with the indexed `arkiv.schema` attribute. Every entity also carries `app` (str, default `kinetic`, set with `ARKIV_APP`). The column definitions are `COLUMNS` in [src/integrations/arkiv.ts](../src/integrations/arkiv.ts).

An Arkiv entity is only typed attributes. Columns are typed: `addr` for EVM addresses (read back checksummed; KINETIC compares them lower-case, and stores "no address yet" as the zero address), `key` for a link to another entity, `u64` for amounts in base units (tinybar) and counts, `str` otherwise. Only the columns in **bold** are indexed, so only they can be filtered on; the rest are stored and can be sorted on. The JSON payload is the unindexed `bytes` attribute `payload` (UTF-8 JSON, `{}` when there is none). A str holds at most 128 bytes, an attribute name at most 32, and an entity at most 32 attributes (the schema tag is one of them, `app` and `payload` two more). Expiry is in 2-second blocks; extending an entity sets its expiry to the TTL from now.

| kind | Owner (who can edit) | Attributes | Expires | Payload (JSON) |
|---|---|---|---|---|
| `offer` | the provider's wallet | **`provider`** addr, `pay_to` str (Hedera account), `name`, `endpoint`, `gpu` str, **`price`** u64 (tinybar per chunk), `bond` u64 (tinybar), **`task.classify`** / **`task.extract`** / **`task.tag`** u64 = 1, **`model.<key>`** u64 = 1 per listed model it serves, **`uaid`** str (short HCS-14 key), `adversarial` str (only on an adversarial test provider: how it cheats), `zg_provider` addr (its 0G Compute provider), `hcs10_inbound` str (its HCS-10 inbound topic, once listed in the Hashgraph Online registry), `erc8004` u64, `sandbox` str | 90 s; the provider extends it every 30 s | name, endpoint, compute, tasks, declared backend (e.g. `0g:0gm-1.0-35b-a3b`), x402 network, HCS-14 profile |
| `claim` | the buyer agent's wallet | **`job_id`** str, `idx` u64, `provider` addr | 2 min (a lease); deleted early when the chunk returns | — |
| `job` | the buyer agent's wallet | **`job_id`** str, `task` str, `status` str (`running` / `complete` / `incomplete`), `total`, `done`, `rerouted`, `paid`, `refunded`, `fee`, `royalty` u64, `audit_ref` str (public Swarm reference), `model` str | 7 days | task kind, label or field names, chunk size |
| `chunk` | the buyer agent's wallet | **`job_id`** str, **`job_key`** key (its `job` entity), `idx` u64, `status` str (`pending` / `claimed` / `done` / `verified`), `provider` addr | 7 days | `encRef` and `resultRef`: Swarm references sealed with AES-GCM (never plain, because encrypted Swarm references contain their key) |
| `reputation` | the verifier's wallet | **`provider`** addr, **`status`** str (`ok` / `slashed`), `pass`, `fail`, `score` u64 (0–100), `window` str (the verifier's recent checks, oldest first, `1` pass / `0` fail), `latency_ms` u64, `adversarial` str (copied from its offer, so the label outlives it), qualification and fingerprint results | 30 days, extended on every canary | — |
| `check` | the verifier's wallet; created **readonly** | **`provider`** addr, **`pass`** u64 (1 or 0), `src` str (`canary` / `format` / `execution` / `admission`), `at` u64 (unix seconds), `job_id` str and `idx` u64 on job checks | 7 days, never extended | — |
| `model` | the verifier's wallet | **`mkey`**, **`model_id`**, **`version`**, **`status`** str, **`task.<kind>`** u64 = 1, `name`, `creator`, `engine`, `passport_ref`, `passport_digest` str, `royalty_bps`, `accuracy` u64 | 30 days, renewed by the verifier | the listing: card, Model Passport reference and digest, signers |

Prices and scores are integers in base units (tinybar, percent), so they are `u64`, not `dec`: a `u64` is exact and sorts and compares the same way.

Entities written before named schemas carry a `kind` str attribute instead of the tag, and untyped (str/u64) values. KINETIC's reads match both (`(arkiv.schema = … AND …) OR (kind = … AND …)`) until those expire; the verifier re-creates an old `reputation` on the new schema the first time it updates it, and deletes the old one.

## Trust rules readers apply

Anyone can write an entity with KINETIC's tag and attribute names, so readers trust entities by who wrote them. `$creator` never changes; `$owner` does when an entity is handed over, and only the owner can patch or delete.

- An `offer` counts only if it was created by, and is still owned by, the address in its `provider` attribute, so nobody can publish an offer for someone else (not even by creating one and handing it over).
- A `reputation` counts only if it was created by, and is still owned by, the verifier address that `GET /status` on the verifier reports (`createdBy` + `ownedBy`).
- A `check` counts only if it was created by that verifier (`createdBy`). Checks are created `readonly`: once written, nobody, the verifier included, can change one.
- A `model` listing counts only if one of the vault's verifiers created it and one owns it.
- A provider's live record is the count of its unexpired `check` entities. Nothing is ever patched or flagged: a result older than 7 days simply stops being counted. Buyers rank on it, and call a provider `active` when it has a pass in the last 6 hours.
- `bond` on an offer is informational. Buyers read the real bond from the Hedera vault before paying.

## Queries

Bonded classification offers:

```
arkiv.schema = str('kinetic.offer') AND app = str('kinetic') AND task.classify = u64(1)
```

All chunks of a job, to draw its progress grid:

```
arkiv.schema = str('kinetic.chunk') AND app = str('kinetic') AND job_id = str('<jobId>')
```

A provider's live passes (count them with `count()`, filter with `createdBy(<verifier>)`):

```
arkiv.schema = str('kinetic.check') AND app = str('kinetic') AND provider = addr(<address>) AND pass = u64(1)
```

Buyers read a provider's newest 100 checks sorted by Arkiv (`orderBy(desc("at"))`) with `withCount()`, so the total is exact without paging; only a provider with more checks needs a `count()` of its passes.

Slashed providers, as judged by the verifier (filter with `createdBy(<verifier>)` and `ownedBy(<verifier>)`):

```
arkiv.schema = str('kinetic.reputation') AND app = str('kinetic') AND status = str('slashed')
```

## Live reads

The dashboard doesn't poll Arkiv. The verifier follows Arkiv's entity events (`watchEntityEvents`: created, patched, extended, transferred, deleted), re-reads only the entity an event names with `getEntity` (only `arkiv_query` is metered), and pushes the change to the dashboard over Server-Sent Events (`GET /arkiv/events` on the verifier). Arkiv emits no event on expiry, so the verifier drops entities at their expiry time, and re-reads every kind in full every few minutes to correct anything an event missed. It recreates the watcher when it fails, stalls or falls about 1,000 blocks behind, and re-reads in full after. `GET /arkiv/stats` reports its metered reads against what the old polling would have spent.

## Writers

`npm run live` lists the wallet addresses that wrote each kind of entity in `out/live-<jobId>.md`, with explorer links.
