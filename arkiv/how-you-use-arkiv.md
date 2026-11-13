# How KINETIC uses Arkiv

Arkiv holds the state that several parties who don't trust each other share while a job runs: providers, buyer agents, the verifiers and the dashboard. The entities, their fields, owners and expiries are in [schema.md](schema.md). Each Arkiv feature below changes something users see.

## What readers use, who can edit, and when it expires

| Entity | Fields readers use | Who can edit | Expires | Why that fits |
|---|---|---|---|---|
| `offer` | `task.<kind> = 1`, `model.<key> = 1` | the provider | 90 s, extended every 30 s | Buyers search by what a provider can do and what it costs. A provider that dies stops extending its offer and drops out. |
| `claim` | `job_id`, `idx` | the buyer | 2 min | A lease: a chunk held by a provider that dies frees itself. |
| `job`, `chunk` | `job_id`, `status` | the buyer | 7 days | The buyer runs the job, so only the buyer moves it forward. Seven days is long enough to audit it. |
| `check` | `provider`, `pass` | nobody: created `readonly` | 7 days, never extended | A check result can't be edited, even by the verifier. A provider's record is its unexpired checks, so old results simply age out. |
| `reputation` | `provider`, `status` | the verifier | 30 days, extended on every check | The provider it describes can't touch it. |
| `model` | `model_id`, `version`, `status`, `task.<kind>` | the verifier | 30 days, renewed by the verifier | A listing exists only while a verifier vouches for it. |

Readers also check who wrote an entity, `$creator` and `$owner`, not just its tag. Anyone can write an entity named `kinetic.offer`, but it counts only if the provider in it created it and still owns it ([schema.md, Trust rules](schema.md#trust-rules-readers-apply)).

## Each Arkiv feature, and what users see

| Arkiv feature | What it does in KINETIC | What users see |
|---|---|---|
| **Expiry** on `offer` and `claim` | Liveness without a cleanup job: a dead provider's offer lapses, and an abandoned claim frees its chunk | The GPUs page drops a provider within 90 s. Claimed chunks pulse on the job grid, then go back to pending if the lease lapses |
| **Expiry** on `check` | A provider's record is a rolling 7-day window | The buyer agent ranks providers on their unexpired checks, so an old pass or fail stops counting by itself |
| **Owner wallets and `$creator`** | Offers belong to providers, jobs to buyers, checks, reputation and listings to verifiers | Reputation and listings can't be forged or edited by the provider they describe |
| **`readonly` entities** | Every check result is written once and frozen | A check shown on a job page can't have been changed after it was written |
| **Named schemas** (`defineSchema`, `kinetic.*`) with typed columns | `u64` prices and scores are exact integers, and `addr` columns hold addresses | The GPUs page shows each provider's score, passes and fails, and a slashed label, straight from its `reputation` entity |
| **Attribute filters** | Buyer discovery: `arkiv.schema = str('kinetic.offer') AND task.classify = u64(1)`. The dashboard reads jobs by `job_id` and slashed providers by `status` | The buyer agent picks providers from Arkiv alone, and every dashboard page reads its data from Arkiv |
| **Entity events** | The verifier's Arkiv mirror follows live events and re-reads only what changed, then streams it to the dashboard (Server-Sent Events) | Chunk progress, claims and new offers appear on screen within seconds, without polling |
| **Batched writes** (`executeBatch`) | One wallet means one nonce sequence. The store queues writes, merges patches to the same entity, and sends up to 40 operations in one transaction | Chunk status updates arrive in near real time without one transaction per change |
| **Payloads** | Jobs carry `audit_ref`, listings carry the model card and passport reference | Each finished job links to its Compute Passport on 0G Storage, and each model page to its passport |

## A query you can run

```bash
curl -s -X POST https://rpc.rabdi.db-chain.testnet.arkiv.network/ -H "Content-Type: application/json" -d \
  "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"arkiv_query\",\"params\":[\"arkiv.schema = str('kinetic.model') AND app = str('kinetic') AND status = str('listed')\",{\"limit\":20,\"select\":{\"key\":true,\"attributes\":true}}]}"
```

This returns the model listings the verifiers vouch for, the data behind the dashboard's Models page. The public RPC is heavily rate limited; with an [access key](https://hub.arkiv.network/access-keys), add it to the end of the URL.

## Code

- Store, schemas, batching and events: [src/integrations/arkiv.ts](../src/integrations/arkiv.ts)
- Offer lifecycle and heartbeat: [src/provider/node.ts](../src/provider/node.ts)
- Job, chunk and claim writes, and discovery: [src/agent/buyer.ts](../src/agent/buyer.ts)
- Checks and reputation: [src/verifier/verifier.ts](../src/verifier/verifier.ts)
- Model listings: [src/verifier/models.ts](../src/verifier/models.ts), [src/models/registry.ts](../src/models/registry.ts)
- Live mirror and dashboard reads: [src/verifier/arkiv-mirror.ts](../src/verifier/arkiv-mirror.ts), [src/verifier/service.ts](../src/verifier/service.ts), [web/src/data.ts](../web/src/data.ts)
