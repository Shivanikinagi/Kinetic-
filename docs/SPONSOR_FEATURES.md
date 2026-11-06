# What else the sponsors offer KINETIC

From a full read of the official docs (0G: 85 pages via llms-full.txt; Hedera: ~450 indexed pages, ~75 read in full; Arkiv: all 28 docs pages plus the Hub, SDK changelog and skills repo; Swarm: all 86 pages plus the Bee API spec and bee-js). Effort: S = hours, M = a day, L = more.

## Top picks across all four

| # | Sponsor | Feature | Why it matters for KINETIC | Effort |
|---|---|---|---|---|
| 1 | Hedera | **Backup x402 facilitators** (Blocky402, Launa) | Fixes the Cloudflare 520 failures from x402.org: fall back when one doesn't answer | S |
| 2 | 0G | **`private` trust mode + self-verified canaries** | `verified` includes TeeTLS relays to centralized upstreams; `private` is TeeML only. Check the TEE signature ourselves and put it in the Compute Passport | S–M |
| 3 | Arkiv | **Live events (`watchEntityEvents`) instead of polling** | Cuts read cost (only `arkiv_query` is metered) and makes the dashboard real-time | M |
| 4 | Swarm | **Our own postage batch** | Passports on the public gateway aren't guaranteed to persist without one | S (Beeport) – M |
| 5 | Hedera | **HIP-1215 scheduled contract calls** | The vault finalizes slashes itself when the dispute window ends; no keeper | M |
| 6 | Arkiv | **`readonly` checks + `createdBy` filters** | A tamper-proof audit trail, the documented trust pattern | S |
| 7 | Hedera | **PRNG for canary selection + Merkle anchor per job** | Spot checks nobody can predict; one HCS anchor per job, proof per chunk | S–M |
| 8 | Swarm | **Feeds for passports** | A stable "latest passport" URL per model, signed by a publisher key | S–M |
| 9 | Arkiv | **Named schemas, typed columns, server `orderBy`/`withCount`** | The documented data model; cheaper reads, leaderboards without paging | S–M |
| 10 | 0G | **Storage SDK ECIES encryption for job chunks** | Encrypt each chunk to the GPU's own key with 0G's built-in scheme | S–M |

**Status (3 Nov):** 1–9 are built and verified live on testnet in the dashboard; 4 waits on buying a postage batch (`docs/SWARM_STAMP.md`). 10 was evaluated and not built: per-chunk uploads cost a fee and ~20 s each, the SDK's ECIES has no authentication (weaker than our AES-GCM wrap), and extra uploads would reveal which chunks are canaries. PRNG picks post-job spot checks rather than canaries, since a ledger seed is public the moment it exists.

## 0G

**High value now**
- **Trust mode `private`** ([privacy](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/privacy)): header `X-0G-Provider-Trust-Mode: private` routes to TeeML only (the model itself runs in Intel TDX on TEE GPUs). `verified` also allows TeeTLS, a TEE broker relaying to a centralized upstream. No TeeML provider free: `503 no_provider_for_trust_mode`, never a silent downgrade. Live (2026-11-03): glm-5.3 has 2 TeeML providers (0G Foundation) and 4 TeeTLS listings (Baidu, Tencent relays). **Done:** canaries run `private`, falling back to `verified` with a note in the canary.
- **Verify the canary ourselves** ([verifiable execution](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/verifiable-execution)): `tee_verified` only appears with `verify_tee: true` and is the Router's word. Fetch `GET {provider}/v1/proxy/signature/{chatID}` (or `broker.inference.processResponse`) and check the EIP-191 signature against the provider's on-chain `teeSignerAddress`; store signed text + signature in the Compute Passport. **Done** (src/integrations/zerog-tee.ts): providers are on the mainnet serving contract (`0x4734…8d84`, chain 16661), not Galileo; the router seals requests (`X-0G-E2EE: sealed`) so the TEE signs ciphertext hashes (`zg-sig-v1/e2ee-ct`), which we can verify as signed by the registered enclave but can't bind to the plaintext; the router returns no `tee_verified` on sealed requests even with `verify_tee: true`.
- **Pin a provider and cap price** ([routing](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/routing)): `X-0G-Provider-Address` (no fallback), `X-0G-Provider-Max-Price-Usd-*`; `GET /v1/providers?model=` lists TEE type and attestation.
- **Reproducible canaries**: glm-5.3 supports `seed` (0gm-1.0-35b-a3b doesn't); thinking off with `chat_template_kwargs: {"enable_thinking": false}`. **Not used:** only the TeeTLS (Tencent) listings take `seed`, and one of the two TeeML providers writes its reasoning into the answer under `enable_thinking: false`, so `private` canaries stay at temperature 0 with thinking on.
- **Storage encryption** ([storage SDK](https://docs.0g.ai/developer-hub/building-on-0g/storage/sdk)): `{encryption: {type: 'ecies', recipientPubKey}}` or `'aes256'` (SDK ≥ 1.2.6); decrypt via `downloadToBlob` (in memory: chunks, not weights). **Evaluated, not adopted for job chunks:** one on-chain upload per chunk (fee, ~20 s), ECIES to one GPU means re-uploading on every reroute and a second copy for the verifier's canary run (public uploads would reveal which chunks are canaries), and the scheme is AES-256-CTR with no authentication or context binding, weaker than the AES-GCM, context-bound key wrap KINETIC uses. Fits closed-weight model distribution to one serving provider later.
- **ERC-8004** ([docs](https://docs.0g.ai/developer-hub/building-on-0g/agentic-id/erc8004)): done. Show agents on 8004scan.io; the Validation Registry is "still evolving", which is the gap KINETIC's verifier quorum fills.
- **Exact cost per request**: `x_0g_trace.billing.total_cost` (neuron); `GET /v1/account/usage/history` with an `mk-` key.

**Later**: provider attestation check (`verifyService`); becoming a 0G inference provider (needs TDX + H100/H200); fine-tuning to a LoRA adapter on 0G Storage, then publish it to the hub; Storage KV for a mutable model index; Storage HTTP gateway `GET /file?root=`; Router testnet (`router-api-testnet.integratenetwork.work/v1`); Goldsky subgraphs; ERC-7857 only for closed-weight models.

**Already used, to improve**: Router `verified` → `private`; files over 4 GB come back as several roots; per-agent `sk-` keys minted from a server-side `mk-` key (never in the browser); honour `X-RateLimit-*`.

## Hedera

**High value now**
- **Facilitator failover** ([facilitators](https://docs.hedera.com/solutions/ai/x402/facilitators)): Blocky402 `https://api.testnet.blocky402.com` (feePayer 0.0.7162784), Launa `https://testnet.facilitator.launa.dev` (0.0.9839454), no API keys; each has `/supported`, `/verify`, `/settle`. x402.org is "aimed at quickstart and testnet".
- **HIP-1215 `scheduleCall`** ([schedule service](https://docs.hedera.com/evm/hedera-services/system-contracts/schedule-service)): the vault schedules its own `finalize()` at `0x16b` for when the dispute window ends; `deleteSchedule` cancels if overturned. Live since v0.68; testnet only (no Hardhat).
- **Merkle-anchored receipts** ([batch-anchor-verify](https://docs.hedera.com/native/tutorials/consensus/batch-anchor-verify)): one ~215-byte `hcs.merkleRootAnchor` per job, a proof per chunk.
- **PRNG** ([prng](https://docs.hedera.com/native/prng)): `getPseudorandomSeed()` at `0x169` or `PrngTransaction` ($0.001) to choose canary chunks unpredictably.
- **HIP-632 `isAuthorizedRaw`**: check verifier signatures (ECDSA or ED25519) inside the vault.
- **Dynamic passport NFT** (HIP-657 + HIP-412): metadata updatable on revocation; ≤100-byte pointer; $0.02 mint.
- **Hedera Agent Kit plugin** ([create plugins](https://docs.hedera.com/solutions/ai/agent-kit/js/create-plugins)): a `kinetic` plugin (`submit_batch_job`, `get_compute_passport`) so any Hedera agent can buy verified inference; `HcsAuditTrailHook`; list it via PR.

**Later**: atomic batch transactions (HIP-551: refund + royalty + receipt together); Exchange Rate contract `0x168` (bonds in USD); paid topics (HIP-991); native 2-of-3 threshold keys; auto account creation for new GPUs; Agent Lab / hosted MCP; HCS-11 profiles.

**Already used, to improve**: `maxTimeoutSeconds` ≤ 180 (**done**: capped at 180 in src/integrations/x402.ts); Hashio is "for development and testing" (name a fallback relay); weibar (18) vs tinybar (8) decimals in the vault; mirror node ~50 req/s, follow `links.next` (**done** for HCS receipts, src/integrations/hcs.ts); `AccountBalanceQuery` deprecated (use `MirrorNodeAccountBalanceQuery`); verify the vault through Sourcify (HashScan's manual verify is disabled).

## Arkiv

**High value now**
- **`watchEntityEvents`** ([watch events](https://docs.arkiv.network/querying/watch-events/)): created/patched/extended/transferred/deleted events, polled every half block; no event on expiry; recreate the watcher if it falls ~1,000 blocks behind.
- **`getEntity(key)` for known keys**: per the official skills repo, only `arkiv_query` is metered (10 units; 100M per key per month); confirm on the Hub Usage tab. **Done** (src/integrations/arkiv.ts `get`): reads by key use `getEntity` and are counted apart from metered queries.
- **Server `orderBy` and `withCount`** ([sort](https://docs.arkiv.network/querying/sort/), [count](https://docs.arkiv.network/querying/count/)).
- **Named schemas** ([define](https://docs.arkiv.network/schemas/define/)): `defineSchema("kinetic.offer", …)` adds an `arkiv.schema` tag (31 columns left) and replaces our manual `kind`.
- **Creation flags** ([create](https://docs.arkiv.network/writing/create/)): `readonly: true` for checks and chunks; `permissionlessExtension` for model listings.
- **Typed columns** ([column types](https://docs.arkiv.network/schemas/column-types/)): `dec`, `addr`, `key`; index only filtered columns.
- **`createdBy`** filters: `$creator` never changes.
- **Access keys** ([access keys](https://docs.arkiv.network/start-here/access-keys/)): Usage tab, "Request more quota", IP allowlist for the verifier, Origin-locked key for the browser; monthly quotas.
- **`predictEntityKeys` + `executeBatch`**: create a job and its chunks atomically, linked by key.

**Later**: `changeOwnership` (hand a job to the claiming GPU); Arkiv MCP (`mcp.arkiv.network`) and agent skills; `arkiv-sync`; `arkiv-encryption`. The Hub's ecosystem page lists open challenges that fit the pitch ("pay-per-query data commons", "trigger network for expiring data").

## Swarm

**High value now**
- **Own postage batch** ([buy a stamp batch](https://docs.ethswarm.org/docs/develop/tools-and-features/buy-a-stamp-batch)): needs a light/full node with xDAI + xBZZ, or Beeport (pays from a chain you hold funds on). Depth 19 holds 112 MB; about 5.4 xBZZ for 30 days at current prices (estimate). Always immutable for feeds; watch `batchTTL`.
- **Client-side stamping**: bee-js `Stamper` + `swarm-postage-stamp` header on `/chunks`; whether the public gateway forwards it needs one test request.
- **Feeds and feed manifests** ([dynamic content](https://docs.ethswarm.org/docs/develop/dynamic-content)): one feed per model (topic = model id), a stable `/bzz/<manifest>/` URL, SOC-signed by a publisher key.
- **Erasure coding** ([erasure coding](https://docs.ethswarm.org/docs/develop/tools-and-features/erasure-coding)): `swarm-redundancy-level: 1–4` on `/bytes` uploads of passports.

**Later**: own light node + pinning and stewardship; ACT access control for job data (own node; `/bzz` and `/bytes` only); GSOC/PSS for job notifications (full node to receive); manifests + ENS for a static verifier site. Ecosystem: swarm-ai-data-exchange, swarm-mcp, Swarm's "verifiable provenance" and "AI agent economy" papers.

**Already used, to improve**: the docs say never send 128-hex (encrypted) references to a public gateway, because the second half is the decryption key; our chunks are already AES-GCM sealed, so upload them as plain 64-hex `/bytes` and keep the key in Arkiv only. **Done** (src/integrations/swarm.ts): Swarm encryption is off by default and refused on a public gateway or with client-side stamps. The docs recommend bee-js over the raw API.
