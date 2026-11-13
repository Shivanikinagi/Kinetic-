# KINETIC — Complete Project Guide

> A full explanation of what KINETIC is, what it is built with, why each piece was chosen, and how everything connects. File references are relative to the `KINETIC/` folder.

---

## Contents

1. [What KINETIC is, in one minute](#1-what-kinetic-is-in-one-minute)
2. [The problem it solves](#2-the-problem-it-solves)
3. [The four ideas: Split, Verify, Enforce, Recover](#3-the-four-ideas-split-verify-enforce-recover)
4. [The cast: the roles in the system](#4-the-cast-the-roles-in-the-system)
5. [Technology stack: what, why, and where](#5-technology-stack-what-why-and-where)
6. [Architecture: how the pieces connect](#6-architecture-how-the-pieces-connect)
7. [A job, step by step](#7-a-job-step-by-step)
8. [Each integration in depth](#8-each-integration-in-depth)
9. [Trust and security model](#9-trust-and-security-model)
10. [Money: who pays whom, and how refunds work](#10-money-who-pays-whom-and-how-refunds-work)
11. [The dashboard (web app)](#11-the-dashboard-web-app)
12. [Test harness (devnet)](#12-test-harness-devnet)
13. [Running the project](#13-running-the-project)
14. [Configuration reference](#14-configuration-reference)
15. [Tests](#15-tests)
16. [Code map: every folder and file](#16-code-map-every-folder-and-file)
17. [Ports and HTTP endpoints](#17-ports-and-http-endpoints)
18. [Live testnet evidence](#18-live-testnet-evidence)
19. [Known limits and housekeeping](#19-known-limits-and-housekeeping)
20. [Glossary](#20-glossary)

---

## 1. What KINETIC is, in one minute

**KINETIC is a marketplace where AI agents rent cheap community GPUs for batch AI work, without having to trust the people who own those GPUs.**

An AI agent (the *buyer*) has a big batch job, for example "label these 120 support tickets as billing / bug / account / shipping / feature_request / other". Instead of paying an expensive hosted API, it sends the work to community GPU owners (the *providers*). Because any provider could be lazy, broken or dishonest, KINETIC:

- splits the job into small **chunks** and pays for **each chunk separately** (x402 micropayments on Hedera);
- plants a hidden **known answer** in every chunk, and secretly re-checks some chunks (**canaries**) against a reference model running on **0G Private Computer**;
- makes every provider post a **bond** in a smart contract, and **slashes** it to **refund the buyer** if the provider fails too many checks (a quorum of verifiers must sign, and the provider can dispute);
- **re-routes** work away from providers that fail, crash or get slashed.

Every payment, check and slash leaves a public record (Hedera HCS, Arkiv, 0G Storage, 0G Chain), and a live dashboard shows it all. Each job ends with a signed **Compute Passport**.

KINETIC is also a **model hub**: creators publish models with a quorum-signed **Model Passport** (malware checks, benchmark, fingerprint), and earn a royalty on every accepted chunk a job runs on their model (§8.19).

Everything is real: there is no demo mode, simulator or mock in the product. Providers are real nodes on the real testnets; by default each one runs its work on **0G Compute** (`0gm-1.0-35b-a3b`, 0G's own TeeML model) with its own 0G key, or on its own OpenAI-compatible server. Of the five testnet providers, two are honest and three are **adversarial test providers** that really cheat — and say so in their offers — so the checks have something real to catch.

**Outcome for the buyer:** you only end up paying for chunks that completed and passed verification.

It was built as a hackathon project targeting three sponsor tracks: **Hedera** (x402 payments in HBAR, HCS, HCS-14, PRNG, scheduled calls), **0G** (Private Computer / iAI credits, 0G Compute, 0G Storage, ERC-8004 on 0G Chain) and **Arkiv** (on-chain shared state).

---

## 2. The problem it solves

| Problem | Why it's hard | KINETIC's answer |
|---|---|---|
| Hosted AI APIs are expensive for large batch jobs | Millions of tokens add up | Use idle community GPUs, priced per chunk |
| You can't trust an anonymous GPU owner | They might skip the model and return junk, or crash | Admission probes, hidden canaries, format checks |
| Paying up front means losing money to bad providers | No recourse once paid | Pay per chunk, settle only on success, slash bonds to refund |
| Providers come and go | A crashed provider strands work | Expiring offers and leases on Arkiv; automatic re-routing |
| A central marketplace operator could cheat | They could hide offers, edit reputations | State lives on Arkiv (owned, signed entities), receipts on HCS |
| Job data is private | Providers and the public shouldn't see everything | Per-chunk AES-GCM encryption; chunks travel only inside the paid request, never on a public store |

---

## 3. The four ideas: Split, Verify, Enforce, Recover

1. **Split** — The job is cut into fixed-size, independent chunks (`src/core/chunker.ts`). Each chunk is its own paid HTTP request, so the buyer's risk at any moment is one chunk's price.
2. **Verify** — Four different signals:
   - **Admission probe (before work):** the verifier pays each provider for one chunk of tickets whose true labels are known (`data/gold-tickets.jsonl`). Providers below the threshold are never given paid work.
   - **Planted known answers (every chunk):** the verifier hides one labelled item in every chunk, under an id that looks like the buyer's own (`src/verifier/known.ts`). This is ground truth, and what slashing rests on (§8.16).
   - **Format check (every chunk):** every item answered exactly once, only allowed labels (`src/tasks/validate.ts`).
   - **Hidden canaries (sampled):** ~25% of real chunks are also run on 0G's reference model (`glm-5.3`, a different model from the one the providers run, so two independent models are compared); the provider's answer must agree ≥ 80% (`src/tasks/compare.ts`). A failed canary fails the chunk but doesn't slash (unless `CANARY_MODEL_SLASHES=true`). After the job, a Hedera PRNG seed picks extra spot checks (§8.18).
3. **Enforce** — If a provider fails 3 of its last 10 checks, the verifier proposes a slash in the `KineticBondVault` contract. The vault's other verifiers re-check the evidence and co-sign (2 of 3 on testnet). After a dispute window the slash executes: the buyer is refunded from the provider's bond, and the rest is burned (§8.4).
4. **Recover** — Chunks from crashed, failed, slashed or quarantined providers go back on the queue for other providers (`src/agent/buyer.ts`).

---

## 4. The cast: the roles in the system

Every role is a separate program with **its own secp256k1 private key**. That single key is simultaneously:
- its **Hedera ECDSA account** (for payments and HCS),
- its **Arkiv owner wallet** (for writing entities),
- its **EVM address** (in the bond vault, and for signing results).

| Role | What it does | Code |
|---|---|---|
| **Buyer agent** | Owns the job. Splits, encrypts, registers the sealed chunks with the verifier, discovers providers on Arkiv, pays per chunk over x402, submits results to the verifier, re-routes, produces the final report and the signed Compute Passport. Also runs the "Run a job" API. | `src/agent/` |
| **Provider node** (×5 on testnet) | A compute provider. Posts a bond, publishes an expiring offer on Arkiv (declaring its backend and model, e.g. `0g:0gm-1.0-35b-a3b`), serves `POST /v1/chunks` behind an x402 paywall, runs the model on 0G Compute or its own server, signs results. | `src/provider/` |
| **Verifier agent** | The referee. Picks hidden canaries and commits to them on HCS, plants known answers, runs 0G reference runs (checking each one's TEE signature), does admission probes, checks signatures and payments, writes reputation and per-check entities to Arkiv and ERC-8004 feedback to 0G Chain, proposes slashes in the vault with the cosigners' signatures, settles them after the dispute window, draws PRNG spot checks and anchors each job's Merkle root on HCS, reviews and lists models, and serves the dashboard's cached reads. | `src/verifier/` |
| **Cosigners** | The vault's other verifiers. Before signing a slash each one re-checks the evidence on its own: the canary commitment on HCS, its own 0G runs of the failed canaries, the format and 0G execution checks, the provider's signatures, and the refund against the mirror node. They also vote on disputes. | `src/verifier/cosigner.ts` |
| **Model creator** | Publishes a model: a signed model card, weights on 0G Storage or at a source URL (malware-checked on the creator's machine first), and a listing fee to the verifier. Earns a royalty on every accepted chunk of a job on that model. | `src/models/`, `npm run kinetic -- models publish --card card.json` |
| **Dashboard** | React web app: a landing page, the Models hub and a full-screen Console (§11). Reads public state (Arkiv, HCS via mirror node, verifier status) and lets a human start and stop jobs, publish models. | `web/` |
| **Test harness (devnet)** | Emulator of every external network, used only by the automated tests; refused outside the test runner. | `test/support/` |

### The five testnet providers

Two honest providers and three **adversarial test providers** (`src/testnet/roles.ts`). They are real nodes on the real testnets; the adversarial ones really cheat, so their payments, slashes and refunds are real too. Every non-honest provider publishes an `adversarial` attribute in its Arkiv offer saying how it cheats (`adversarialLabel()` in `src/provider/backend.ts`). Buyers do **not** route on that label — `QuickCompute` is admitted and paid like anyone else, then caught by the checks.

| Name | GPU label | Price/chunk | Behaviour (`PROVIDER_BEHAVIOR`) | Published `adversarial` label | Expected outcome |
|---|---|---|---|---|---|
| `BluePeak` | 0G Compute (TeeML) | 0.001 ℏ | `honest` | — | Passes everything, keeps its work |
| `Riverstone` | 0G Compute (TeeML) | 0.0012 ℏ | `honest` | — | Passes everything, keeps its work |
| `QuickCompute` | 0G Compute (TeeML) | 0.0006 ℏ | `degrade-after:3` (honest for 3 chunks, then stops calling its model) | "stops calling its model after 3 chunks" | Passes admission, misses known answers on job work → **slashed**, buyer **refunded**, its chunks re-routed |
| `EdgeRelay` | 0G Compute (TeeML) | 0.0008 ℏ | `offline-after:5` (goes down while chunk 5 is paid) | "goes down while chunk 5 is paid, keeping that payment" | Really stops serving and its Arkiv offer expires; marked offline, in-flight chunk re-routed, the payment it kept without answering is detected |
| `BudgetGPU` | none | 0.0004 ℏ | `lazy` (never calls a model) | "never calls its model" | **Rejected at admission**, never paid for job work |

A provider can't tell the verifier's admission probes (3 chunks on a fresh start) from job work, so the thresholds count them: QuickCompute cheats from its first job chunk, and EdgeRelay drops on its second. Runs before 2026-11-01 (the evidence in §18) called these providers `atlas`, `nimbus`, `cheapo`, `flicker` and `shoddy`, with thresholds of 1 and 3 chunks.

Other behaviours available: `flaky` (fails 40% of chunks; label "fails 40% of chunks") and `zg-down-after:N` (simulates its 0G Compute provider going down after N chunks). The old names `atlas-4090`, `nimbus-a100`, `cheapo-3060`, `flicker-t4` and `shoddy-1060` now exist only inside the automated test scenario.

---

## 5. Technology stack: what, why, and where

### 5.1 Languages and runtime

| Tech | Used for | Why |
|---|---|---|
| **TypeScript** (strict, ESM) | All backend and frontend code | One language end to end; types for the many wire formats |
| **Node.js ≥ 20** | Runs every role | Built-in `crypto` (AES-GCM, HKDF), `fetch`, `process.loadEnvFile`, `util.parseArgs` |
| **tsx** | Runs `.ts` files directly (`npm run live`, etc.) | No build step for the backend |
| **Solidity ^0.8.24** + **solc** | `contracts/KineticBondVault.sol`, compiled at deploy time | Bonds and slashing need trustless custody of funds |

### 5.2 Backend libraries (`package.json`)

| Package | What it's used for | Where |
|---|---|---|
| `@x402/core`, `@x402/hedera` | The x402 "HTTP 402 Payment Required" protocol: quoting, encoding headers, Hedera `exact` payment scheme, facilitator client (verify/settle) | `src/integrations/x402.ts` |
| `@hiero-ledger/sdk` | Native Hedera SDK: HCS topic messages, account creation, HBAR transfers | `src/integrations/hcs.ts`, `scripts/setup-testnet.ts` |
| `viem` | EVM client: private keys → accounts, message signing/recovery (EIP-191), calling the vault contract via Hedera's JSON-RPC relay (Hashio), Arkiv transport | `src/util/sign.ts`, `src/integrations/vault.ts` |
| `@arkiv-network/sdk` | Writing/querying Arkiv entities (create, patch, extend, delete, `executeBatch`, query DSL) | `src/integrations/arkiv.ts` |
| `@hashgraphonline/standards-sdk` (pinned 0.1.192) | HCS-14 Universal Agent ID creation/parsing | `src/integrations/identity.ts` |
| `express` (v5) | HTTP servers for provider, verifier, agent service (and the tests' devnet emulator) | `src/util/http.ts` and each `server.ts` / `service.ts` |
| `zod` | Validating incoming chunk requests | `src/provider/node.ts` |
| `vitest` | Test runner | `test/` |

### 5.3 Frontend libraries (`web/package.json`)

| Package | What it's used for |
|---|---|
| `react` 18 + `react-dom` | UI |
| `vite` 5 + `@vitejs/plugin-react` | Dev server (pinned to port 5173) and build |
| `@arkiv-network/sdk` + `viem` | Reading Arkiv directly when needed |
| `@privy-io/react-auth` | "Sign in with 0G" (0G's Privy app) |
| `lucide-react` | Icons (header, console, landing page) |
| `@stripe/stripe-js` | Listed as a dependency but **not imported anywhere** — safe to remove |

### 5.4 External networks / services

| Service | Role in KINETIC | Why this one |
|---|---|---|
| **Hedera testnet** | Payments and bonds (HBAR), audit log (HCS), bond vault (EVM), agent identities (HCS-14), PRNG seeds for spot checks (HIP-351), scheduled slash execution (HIP-1215) | Cheap, fast finality; native x402 facilitator support; HCS gives an ordered timestamped log |
| **x402 facilitators** (`x402.org`, then Blocky402 and Launa as failover) | Verify and settle x402 payments on Hedera, pay network fees | The public facilitators listed for Hedera x402; a quote goes to the first healthy one |
| **Hedera Mirror Node** | Public read path: confirm payments really happened, read HCS receipts | Lets the verifier trust the ledger, not the buyer's claim |
| **Hashio JSON-RPC relay** | Talk to the vault contract with standard EVM tooling (viem) | Hedera's EVM endpoint |
| **Arkiv (Rabdi testnet, chain 7794095)** | Shared, owned, expiring coordination state: offers, claims, jobs, chunks, reputation, model listings. Earlier runs wrote to Tiramisu (chain 7738577), Arkiv's earlier protocol, which `@arkiv-network/sdk` 1.0 no longer speaks; its explorer links in §18 still resolve | Ownership + expiry = trustless liveness without a central DB |
| **0G Private Computer / 0G Compute (router-api.0g.ai)** | Referee: the verifier's reference model for canaries (`glm-5.3`, TeeML, served by a 0G Compute node). Workers: what providers run by default (`PROVIDER_BACKEND=0g`, `0gm-1.0-35b-a3b`, 0G's own TeeML model, each provider with its own key). | TEE-backed inference on 0G Compute nodes, paid from 0G credits |
| **0G Storage** (Galileo) | Model weights, Compute Passports and Model Passports: files addressed by Merkle root, every download re-checked against it | Built for large files |
| **0G Chain** (Galileo) | ERC-8004 Identity and Reputation Registries: agent identities for the verifier and every GPU, and per-job feedback | Public, portable agent reputation |
| **0G mainnet serving contract** (chain 16661) | Where the verifier looks up the TEE signer of the 0G node that served a canary | The router's providers are registered there |
| **Ollama / vLLM / llama.cpp** (optional) | A provider's own OpenAI-compatible server, used only with `PROVIDER_BACKEND=openai` (`qwen2.5:3b-instruct` by default) | Any OpenAI-compatible server works |
| **Test harness (devnet)** | Emulator of all the services above, used only by the automated tests (`test/support/`) | Fast, deterministic tests; never part of the product |

---

## 6. Architecture: how the pieces connect

### 6.1 Big picture

```
                         ┌──────────────────────── Dashboard (web/, :5173) ───────────────────────┐
                         │ reads: verifier /status, /arkiv/:kind, /jobs/:id/canaries; mirror node │
                         │ writes: agent /runs, /halt, /resume, /zerog-key                       │
                         └───────────────┬──────────────────────────────────┬─────────────────────┘
                                         │                                  │
                                         ▼                                  ▼
 ┌───────────────────────┐   signed + x402   ┌────────────────────────┐   0G router   ┌──────────────────────┐
 │  Buyer agent (:4600)  │ ────────────────► │  Verifier agent (:4500)│ ────────────► │ 0G Private Computer  │
 │  src/agent/           │ ◄──── verdicts ── │  src/verifier/         │ ◄─ reference ─│ (glm-5.3, TeeML)     │
 └──────────┬────────────┘                   └──────────┬─────────────┘               └──────────────────────┘
            │ x402 per chunk                            │ x402 admission probe
            ▼                                           ▼
 ┌─────────────────────────────────────────────────────────────────────┐
 │ Provider nodes (:5101–5105)  src/provider/   POST /v1/chunks (402)  │──► 0G Compute (0gm-1.0-35b-a3b) or own server (Ollama…)
 └─────────────────────────────────────────────────────────────────────┘

 Shared infrastructure (every role connects through src/integrations/index.ts → connect()):
   Hedera: x402 facilitator (HBAR) · HCS topic · KineticBondVault (EVM) · mirror node
   Arkiv:  offer · claim · job · chunk · reputation entities
   0G Storage: public Compute Passports and Model Passports · model weights
```

### 6.2 The wiring point: `connect()`

`src/integrations/index.ts` is the single place where a role gets all its clients. Given a `NetworkConfig` (from `src/config.ts`) and an `Identity` (private key + Hedera account), it returns a `Services` object:

| Field | Devnet implementation (test harness only) | Testnet implementation |
|---|---|---|
| `arkiv` | `ArkivDevnetStore` | `ArkivSdkStore` (SDK + batched write queue) |
| `vault` | `DevnetBondVault` | `EvmBondVault` (viem → Hashio) |
| `storage` | `DocumentStore` → devnet `/zgs` | `DocumentStore` → 0G Storage (indexer + Galileo RPC) |
| `receipts()` | `DevnetReceiptLog` | `HederaReceiptLog` (HCS) |
| `payer()` | `DevnetPaymentSigner` (EIP-191 authorizations) | `HederaPaymentSigner` (partially-signed `TransferTransaction`) |
| `zerog()` | `ZeroGClient` → devnet `/0g/v1` | `ZeroGClient` → `router-api.0g.ai` |

Because every integration sits behind an interface, **the automated tests drive the same buyer/provider/verifier code that runs on the real testnets**. The product runs only on testnet (`KINETIC_NETWORK` defaults to `testnet`); `loadNetworkConfig` refuses `KINETIC_NETWORK=devnet` outside the test runner, so the devnet adapters in `src/integrations/` are reachable only from tests.

### 6.3 What lives where (and why)

| Data | Stored in | Why there |
|---|---|---|
| Provider offers, claims, job/chunk progress, reputation | **Arkiv** | Shared state that mutually-distrustful parties write; ownership + expiry |
| Chunk inputs and results | **Nowhere stored**: AES-GCM encrypted, sent inside the paid x402 request (and to the verifier at registration) | Too big and too private for a chain |
| Payments | **Hedera** (x402 settlement) | Value transfer with finality |
| Bonds, slashes, refunds | **Hedera EVM** (`KineticBondVault`) | Trustless custody |
| Audit trail (job, chunk, canary, known, slash, reveal, spot, done, …) and one Merkle anchor per job | **Hedera HCS** | Ordered, timestamped, only the verifier can append |
| Model weights | **0G Storage** (or a source URL), hash-pinned in the signed model card | Large public files, checked on every download |
| Model Passports and listings | Passport on **0G Storage**, its digest on **HCS**, the listing on **Arkiv** (`model` entity, written only by a vault verifier) | Anyone can check a listing against its passport |
| Agent identities and reputation | **0G Chain** (ERC-8004) and HCS-14 UAIDs | Public, can't be self-rated |
| Public job record | **0G Storage** (signed Compute Passport, unencrypted, stored by the verifier), its root stored on the Arkiv job | Anyone can check the job |
| Job rules (agreement) | Hash in the HCS `job` receipt; full public form in the passport | Fixed before work starts |
| Keys | **Nowhere public** | Providers get one chunk's key only inside the paid HTTPS request |

---

## 7. A job, step by step

This is `BuyerAgent.run()` in `src/agent/buyer.ts`, with the verifier's side from `src/verifier/verifier.ts`.

```
 Buyer agent                       Providers (community GPUs)          Verifier agent (0G credits)
 ───────────                       ──────────────────────────          ───────────────────────────
 0 set the job's rules (agreement)
 1 split into chunks
   encrypt each (own key)
   job + chunk entities ────► Arkiv
 2 register job + rules + sealed chunks + x402 fee ──────────────────► check the rules
                                                                        pick hidden canaries, plant known answers,
                                                                        return re-sealed chunks
                                                                        commit canary, known + rules hashes ──► HCS
                                                                        0G reference runs on canaries
 3 discover offers ◄──────── Arkiv: offer entities (expire unless renewed)
   check bonds ◄──────────── Hedera: KineticBondVault
   admission probe (via verifier) ──► paid known-answer chunk ──► admitted / rejected
 4 per chunk:
   claim (2 min lease) ─────► Arkiv
   POST /v1/chunks (data) ──► 402 quote
   x402 payment ────────────► verify ─► run model ─► settle
   signed result ◄──────────
 5 submit result + payment ──────────────────────────────────────────► check signature & hash
                                                                        check payment on mirror node
                                                                        receipt ──► HCS
                                                                        format + known-answer check; canary? compare with 0G
                                                                        reputation ──► Arkiv
                                                                        threshold hit? cosigners re-check,
                                                                          2 of 3 sign a slash ──► Vault
                                                                          (dispute window, then refund + burn)
   ◄──────────────────────────────────────────────────────── verdict
   failed / slashed / offline: requeue chunk elsewhere
 6 finalize ─────────────────────────────────────────────────────────► reveal canary set ──► HCS
                                                                        PRNG spot checks, Merkle anchor ──► HCS
                                                                        ERC-8004 feedback ──► 0G Chain
   Compute Passport ───────────────────────────────────────────────────► co-sign if it matches
   signed passport ────────────────────────────────────────────────────► store on 0G Storage (root on the job entity)
```

### Step 0 — Agree on the rules
The buyer turns its requests (check rate, pass mark, its own labelled examples, deadline) into a **job agreement** (`makeAgreement`), never below the verifier's own policy, and sends it with the registration. See §8.14.

### Step 1 — Split and encrypt
- `splitIntoChunks(items, chunkSize)` cuts the items into chunks.
- A random 32-byte **job master key** is generated. For each chunk, `deriveKey(jobKey, "chunk:<idx>")` (HKDF-SHA256) gives a per-chunk AES-256-GCM key.
- Each chunk's items are sealed under its chunk key and kept as base64. Nothing is uploaded: the sealed chunk goes to the verifier at registration and to the provider inside the paid request, and nothing about its contents is written to Arkiv.

### Step 2 — Publish state and register with the verifier
- Arkiv: one `job` entity (status `running`) and one `chunk` entity per chunk (status `pending`).
- `POST {verifier}/jobs` — this request is both **signed** (buyer's key in `x-kinetic-*` headers) and **paid** (x402 fee = `VERIFIER_FEE_PER_CHUNK_TINYBAR × chunks`). It carries the sealed chunks (`chunks: [{idx, data, itemIds}]`); cosigners read chunk data from this registration too.
- The verifier checks the agreement (`agreementProblems`), randomly picks canary indices at the agreed rate (`planCanaries`), computes `sha256(jobId | indices | salt)` and posts this **commitment**, plus the agreement's hash and a commitment to where it planted known answers, to HCS *before any chunk runs*. It plants one of its labelled items in every chunk, at a random position under an id that looks like the buyer's own, and re-encrypts the chunk, returning the re-sealed chunks to the buyer (§8.16). A higher check rate than the network's scales the fee up in proportion. It then starts 0G reference runs on those canary chunks (max 2 at a time).

### Step 3 — Discover and qualify providers
`BuyerAgent.discover()`:
1. Queries Arkiv for `kind=offer AND task.classify=1`, and for reputation entities owned by the verifier.
2. Keeps only the newest offer per provider.
3. Drops offers where: the Arkiv owner ≠ `provider` attribute (forged), the provider is slashed, not on the allowlist, price > max, **HCS-14 UAID doesn't match** the published profile, the **vault shows no bond**, or the provider has **asked to withdraw its bond** (it could take it out mid-job, ahead of a slash).
   An offer's `adversarial` label is **not** a reason to drop it: the buyer records it, but routes only on what it can check.
4. Optionally skips providers whose reliability is below `AGENT_MIN_RELIABILITY` (once they have 5+ checks).
5. **Ranks** the rest by price, track record and measured speed, weighted by the chosen strategy (§8.12).

Then for each provider, the buyer asks the verifier to `POST /qualify`. The verifier sends a **paid probe chunk of 6 known-answer tickets** that looks like any other chunk (random job id, random item ids), and admits the provider only if the output is well-formed and matches ≥ `CANARY_MIN_AGREEMENT` of true labels. Results are cached (30 min if admitted, retried after 2 min if rejected) and recorded on HCS.

### Step 4 — Dispatch with per-chunk payment
The best-ranked admitted providers start working (all of them, unless `AGENT_MAX_PROVIDERS` limits it); the rest wait as **reserves**. One sequential worker per working provider pulls from a shared queue. When a worker stops with work left (offline, slashed or capped), the best reserve steps in. For each chunk:
- **Guards:** the provider's total unverified spend can never exceed its bond (status `capped`); the job budget `AGENT_MAX_JOB_SPEND_TINYBAR` can't be exceeded; the kill switch stops new work.
- A `claim` entity (2-minute lease) is written to Arkiv.
- `payFetch()` sends `POST /v1/chunks` (the sealed chunk in `data`, base64) → gets **402** with a quote → refuses if above `AGENT_MAX_PRICE_TINYBAR` → signs a payment → resends with `PAYMENT-SIGNATURE`.
- On the provider (`PaymentGate.handle`): check the payment matches the quote, block replays, ask the facilitator to **verify**, then **do the work**, and only then **settle**. If the work fails, nothing is settled, so the buyer is not charged.
- The provider decrypts the chunk in the request with the key it was given, runs the model it declared in its offer (on 0G Compute or its own server), hashes the result, and **signs** `{jobId, idx, resultHash}`.
- Network failure after the payment left → `PaymentInFlightError`; the payment id is remembered for reconciliation. Two consecutive failures → provider marked `offline`.

### Step 5 — Verification of each result
The buyer checks the signature itself, then calls `POST {verifier}/jobs/:id/results`. The verifier (serialised per provider with a lock, so two results can't race a slash):
1. Checks job/chunk ids, result hash, and that the signature recovers to the provider.
2. Checks the payment went to that provider's `pay_to` account and **looks it up on the mirror node** to see how many HBAR were actually credited.
3. Writes a `chunk` receipt to HCS.
4. **Format check** — malformed output counts as a failed check.
5. **Known answer** — the planted item is scored against its true label and recorded in a `known` receipt. A miss counts toward slashing. The planted item is removed before the buyer sees the result.
6. If the chunk is a **canary**, compares with the 0G reference (`agreement()`) and writes a `canary` receipt. A failed canary fails the chunk; it counts toward slashing only with `CANARY_MODEL_SLASHES=true`.
7. If `failLimit` of the last `window` checks failed → the verifier sends the evidence to the cosigners, and with a quorum of signatures **proposes a slash** (§8.4, §10). Without a quorum, a `slash-refused` receipt goes on HCS and the buyer quarantines the provider for the job.
8. Updates the provider's `reputation` entity on Arkiv (copying the provider's `adversarial` label onto it, if its offer published one).

Verdicts: `accepted`, `canary_pass` (chunk becomes `verified`), `canary_fail`, `rejected`. Failed chunks are requeued and the provider is added to that chunk's `avoid` set.

### Step 6 — Quarantine, reconciliation, finalize
- **Quarantine:** a provider that failed any canary in this job but was not slashed loses all its *unverified* chunks; they are re-run by providers with a clean record.
- **Reconciliation:** for each in-flight payment, the buyer checks the ledger. If it settled, it's reported as "paid but undelivered".
- **Finalize:** the verifier posts a `reveal` receipt (canary indices + salt). It then draws a PRNG seed in the vault and re-runs the chunks it picks on 0G (a `spot` receipt, §8.18). Next it posts one `hcs.merkleRootAnchor` over every finished chunk's record (§8.18) and a `done` receipt. Anyone can now recompute the canary hash and the spot picks. After the job the verifier gives each GPU ERC-8004 feedback on 0G Chain (§8.17).
- **Compute Passport:** the buyer builds a signed record of the job (§8.13), asks the verifier to co-sign it (`POST /jobs/:id/attest`), then sends the signed passport to `POST /jobs/:id/passport`. The verifier stores it on 0G Storage unencrypted, paying the storage fee from its own 0G wallet, and returns its root and URL; it stores only a passport signed by the job's buyer and, if it co-signed, the exact passport it co-signed. The root goes in `audit_ref` on the Arkiv job. If storing fails, the job still completes and the report says the passport wasn't stored. Anyone can check it with `npm run passport:verify`.
- The job entity is set to `complete` or `incomplete`, and a `JobReport` is returned (printed and saved to `out/job-<id>.json`). The report, like the passport, carries each provider's `adversarial` label, if it published one.

---

## 8. Each integration in depth

### 8.1 x402 payments — `src/integrations/x402.ts`
x402 revives HTTP status **402 Payment Required** for machine-to-machine payments. KINETIC pays **only in HBAR** (see §8.5).
- **Server side (`PaymentGate`):** fetches the facilitator's `/supported` kinds (to get Hedera's `feePayer`), builds `PaymentRequirements` (`scheme: exact`, network, asset HBAR, amount, payTo), and runs: quote → verify → work → settle. Replay protection keys on a hash of the payment header and keeps it for 10 minutes, past the time any payment stays valid; on testnet the set is saved under `KINETIC_STATE_DIR`, so it survives a restart. The verifier's per-job fee gates share one set, and a job whose fee doesn't settle is dropped.
- **Client side (`payFetch`):** handles one 402 round-trip, enforces a price cap, attaches `PAYMENT-SIGNATURE`.
- **Signers:** `HederaPaymentSigner` builds a partially-signed Hedera `TransferTransaction` that the facilitator completes, pays fees for, and submits. `DevnetPaymentSigner` (test harness only) signs an EIP-191 transfer authorization.
- **Facilitators:** `X402_FACILITATOR_URLS` lists them in order (default `x402.org`, then Blocky402 and Launa, the Hedera testnet facilitators). A quote goes to the first healthy one, and one that gives no answer (5xx, timeout) is skipped for the next.
- **One payee per payment:** the `exact` scheme on Hedera rejects a payment that credits more than one `payTo`, so the verifier fee and the creator royalty are separate payments from the chunk payments.
- **Used by:** every provider's `POST /v1/chunks`, the verifier's `POST /jobs` (its fee), the verifier's admission probes, the model listing fee, and the creator royalty (`POST /jobs/:id/royalty`, paid straight to the creator).

### 8.2 Hedera HCS (audit log) — `src/integrations/hcs.ts`
- The topic's **submit key is the verifier's key**, so only the verifier can append.
- Receipt types: `job` (canary, known-answer and agreement commitments), `chunk`, `known`, `canary`, `format`, `qualify`, `fingerprint`, `redundant` (high tier), `slash`, `slash-refused`, `dispute`, `settle`, `reveal`, `spot`, `done`, `model` (a Model Passport issued) and `royalty`. Each is JSON with `v: 1`.
- **One Merkle anchor per job:** at finalize the verifier also posts an `hcs.merkleRootAnchor` message (§8.18).
- Read back through the mirror node (`readReceipts`) by the dashboard's Audit page.

### 8.3 Hedera mirror node — `src/integrations/mirror.ts`
- `creditedAmount()` reads `/api/v1/transactions/<id>` and sums the HBAR `transfers` to the provider. Retries because the mirror lags consensus by a few seconds. It keeps a `token_transfers` path only so `passport:verify` can still check passports of old KUSD jobs (§18).
- This is why a buyer can't inflate a refund: refunds are sized from what the ledger shows.

### 8.4 Bond vault — `contracts/KineticBondVault.sol`, `src/integrations/vault.ts`
| Function | Who | What |
|---|---|---|
| `bond()` payable | provider | Add HBAR to bond; cancels a pending withdrawal |
| `requestWithdraw()` | provider | Starts a timelock (`withdrawDelay`) so a provider can't run ahead of a slash |
| `withdraw()` | provider | After the delay, takes the bond out |
| `proposeSlash(verdict, signatures)` | anyone, with `threshold` verifier signatures | The verdict names provider, buyer, job, the chunk and result hash that tipped it over, the refund and an evidence hash; signatures are EIP-191 over a digest bound to the vault and chain, sorted by signer. Once per (provider, job). Freezes the bond; pays nothing yet |
| `dispute(id)` payable | the provider, inside `disputeWindow` | Posts a challenge bond of at least `minChallenge` |
| `resolveDispute(id, upheld, signatures)` | anyone, with `disputeThreshold` signatures | Upheld: executes, and the challenge goes to the buyer too. Overturned: the provider keeps its bond and gets the challenge back |
| `executeSlash(id)` | anyone | After the window: pays `min(refund, bond)` to the buyer, marks the provider permanently `slashed`, burns the rest of the bond once no other slash is open. A dispute undecided after `resolveTimeout` is cancelled instead |
| `bondOf(provider)` | anyone | Amount, unlock time, slashed flag, open slashes |
| `drawSeed(tag)` | a verifier | One Hedera PRNG seed (HIP-351) per tag, timestamped on-chain; the verifier draws one per job for spot checks (§8.18) |

**Scheduled settlement:** on Hedera, proposing a slash can also pay for a call to `executeSlash` that the Schedule Service (HIP-1215) runs `SCHEDULE_DELAY` (10 s) after the dispute window closes, so the vault finalizes the slash itself. The delay matters: Hedera's `block.timestamp` is the start of a ~2 s block, and version 3 of the vault, which booked the closing second, saw its scheduled calls run as no-ops. The fee is paid by the verifier, which needs the gas for the whole proposal plus the fee (about 3 ℏ at today's gas price); with less, the proposal goes out unscheduled. That is best-effort: `executeSlash` stays open to anyone, and a slash settles only once. The `settle` receipt says whether it ran `scheduled`.

Note: on Hedera the EVM uses tinybars internally, while JSON-RPC uses weibars (1 tinybar = 10¹⁰ weibar) — handled in `vault.ts`. The contract is compiled with `solc` and deployed by `src/integrations/vault-deploy.ts`.

### 8.5 Payments are HBAR
- Chunk payments, verifier fees, admission probes and bonds are all **HBAR**, so a slash refunds exactly what the buyer paid that provider — there is no exchange rate.
- There is no payment-token setting: `X402_ASSET`, `X402_ASSET_SYMBOL`, `X402_ASSET_DECIMALS` and `X402_REFUND_RATE` are gone (an `X402_ASSET` left in an env file is ignored), as are `setup:testnet --hts` and KUSD token creation. New payments never use an HTS token.
- **History only:** earlier jobs paid in the HTS test token **KUSD** (`0.0.11220110`). Those jobs and the token remain as historical evidence (§18); the dashboard still labels old HCS receipts that carry an `asset` field, and `passport:verify` can still check their passports.

### 8.6 HCS-14 agent identity — `src/integrations/identity.ts`
- Every agent has a **Universal Agent ID (UAID)** = hash of its public profile (registry `kinetic`, name, protocol `x402`, HCS-11 skill codes, and a CAIP-10 `nativeId` such as `hedera:testnet:0.0.x`).
- Providers publish their profile and full UAID in the offer payload, plus a short `uaid:aid:<hash>` key as an attribute (Arkiv caps string attributes at 128 bytes).
- The buyer **recomputes** the UAID and checks the profile names the account the offer pays to. A provider can't borrow another's identity or reputation.
- Implementation note: imports one internal chunk of the standards SDK directly because loading the whole SDK takes over a minute — that's why the version is pinned exactly.

### 8.7 Arkiv — `src/integrations/arkiv.ts`
Seven entity kinds on Arkiv Rabdi (`@arkiv-network/sdk` 1.0), each written through a named schema `kinetic.<kind>` (indexed as `arkiv.schema`) with typed columns, and tagged `app` (default `kinetic`). The full schema, with every attribute's type, is in `arkiv/schema.md`.

| kind | Owner | Key attributes | Expires |
|---|---|---|---|
| `offer` | provider | `provider`, `pay_to`, `name`, `endpoint`, `gpu`, `price`, `bond`, `uaid`, `task.<kind>=1`, `model.<key>=1` per listed model it serves, `adversarial` (only on adversarial test providers); payload also declares the `backend` (e.g. `0g:0gm-1.0-35b-a3b`), sandbox and ERC-8004 identity | 90 s, renewed every 30 s by heartbeat |
| `claim` | buyer | `job_id`, `idx`, `provider` | 2 min lease |
| `job` | buyer | `job_id`, `task`, `status`, `total`, `done`, `rerouted`, `paid`, `refunded`, `fee`, `royalty`, `audit_ref`, `model` | 7 days |
| `chunk` | buyer | `job_id`, `job_key`, `idx`, `status`, `provider` | 7 days |
| `reputation` | verifier | `provider`, `pass`, `fail`, `score`, `status`, `window` (recent checks, `1` pass / `0` fail), `latency_ms`, `uaid`, `qual_*`, fingerprint fields, `adversarial` (copied from the offer) | 30 days, extended on each check |
| `check` | verifier, created **readonly** | `provider`, `pass`, `src` (`canary` / `format` / `execution` / `admission`), `at`, `job_id`, `idx` | 7 days, never extended |
| `model` | verifier | `mkey`, `model_id`, `version`, `status`, `task.<kind>`, `creator`, `passport_ref`, `passport_digest`, `royalty_bps`, `accuracy` | 30 days, renewed by the verifier |

Entities written before named schemas carry a `kind` attribute instead; reads match both until those expire.

**Why expiry matters:** a crashed provider stops renewing, so its offer disappears within 90 s — no delisting step needed. A dead provider's claim lapses on its own.

**Write queue:** one wallet = one nonce sequence, so `ArkivSdkStore` queues writes, merges patches to the same entity, and sends up to 40 operations per `executeBatch` transaction.

**Trust rules readers apply:** an offer counts only if it was created and is still owned by its `provider`; reputation only if created and owned by the verifier address from `GET /status`; a check only if created by that verifier; a model listing only if one of the vault's verifiers created it and one owns it. The `bond` attribute is informational — buyers read the real bond from the vault.

More detail in `arkiv/schema.md`, `arkiv/why-arkiv.md`, `arkiv/how-you-use-arkiv.md`, and the 13 SDK pain points in `arkiv/friction.md`.

### 8.8 Passport storage on 0G — `src/integrations/storage.ts`
- Compute Passports and Model Passports are stored on 0G Storage and addressed by their 0G Merkle root (`0x` + 64 hex); every download is checked against the root (§8.21). Job data never goes here.
- **Who pays:** the verifier stores each Compute Passport (`POST /jobs/:id/passport`) and the listing verifier each Model Passport, paying 0G's storage fee from its own 0G wallet.
- **Public links:** `https://indexer-storage-testnet-turbo.0g.ai/file?root=<root>`. 0G's indexer sends no CORS headers, so the verifier also serves `GET /passports/:root` (bytes checked against the root) for the dashboard.
- **Migration:** `npm run migrate:passports` (dry run by default, `--apply` to execute) is a one-time move of the existing Model Passports to 0G Storage: it reads each old passport over HTTPS once, checks its signed digest, stores the same bytes on 0G and repoints the listing. Passports issued before 2026-11-11 keep a legacy `references.swarmGateway` field, because it is inside the signed body; new ones name the 0G indexer in `references.storageGateway`.

### 8.9 0G Private Computer — `src/integrations/zerog.ts`
- OpenAI-compatible router at `https://router-api.0g.ai/v1`.
- **Reference model (referee): `glm-5.3`** (`ZEROG_MODEL`), a TeeML model served by a 0G Compute node; responses carry the header `X-0G-E2EE: sealed`. It replaced `qwen3.7-flash`, which is TeeTLS — measured: it is served by Alibaba Cloud (`provider_identity: "aliyun"`) through 0G's TLS-attested proxy, not by a 0G node.
- **Workers:** providers on `PROVIDER_BACKEND=0g` run their work here too, on `0gm-1.0-35b-a3b` (0G's own TeeML model), each with its own `ZEROG_API_KEY` (§8.10). Because workers and referee are different models, a canary compares two independent models.
- `reference()` sends the same prompt the providers get (`buildMessages` in `src/tasks/prompt.ts`), `temperature: 0`, in the `private` trust mode (`ZEROG_CANARY_TRUST_MODE`, TeeML only). If no TeeML provider is free (`503 no_provider_for_trust_mode`), it repeats the run in `verified` mode and the canary says so (`ZEROG_CANARY_FALLBACK=none` turns that off). Keeps `request_id`, the serving 0G node address and cost from `x_0g_trace`, and `e2ee` from the `X-0G-E2EE` header.
- **What the evidence is:** no 0G route returns the router's own `tee_verified` verdict, so KINETIC checks the TEE signature itself (`src/integrations/zerog-tee.ts`): it looks the serving provider up in 0G's inference serving contract on 0G mainnet, fetches the signature from the provider's own endpoint (`GET {url}/v1/proxy/signature/{chatId}`) and recovers it against a TEE signer the provider registers on-chain (`teeSignersOf`: its `teeSignerAddress`, or its separate target enclave's address when `TargetSeparated` is set; sealed router exchanges are signed by the former). The router seals each request end to end, so the TEE signs hashes of the ciphertext: the signature proves the registered enclave served the exchange, but can't be bound to the plaintext answer. A signature that doesn't verify means that canary isn't scored.
- **Measured:** all ten 0G chat models tested scored 100% on the 36 gold tickets, so a weaker 0G model can't be used to produce real failures — that is why the adversarial test providers cheat by behaviour (§4) rather than by model choice.
- `balance()` reads remaining credits for the dashboard.
- **The economic loop:** the verifier *spends* 0G credits on canary runs and *earns* x402 fees from buyers. 0G credits refresh daily and expire, so verification capacity is perishable — a reason to come back daily.

### 8.10 Model backends — `src/provider/backend.ts`, `src/tasks/`
A provider declares its backend with `PROVIDER_BACKEND`, and `backendFromEnv` builds it:

| `PROVIDER_BACKEND` | Runs on | Model | Declared in the offer as |
|---|---|---|---|
| `0g` (default) | 0G Private Computer (`https://router-api.0g.ai/v1`) with the provider's own `ZEROG_API_KEY` | `PROVIDER_MODEL`, default `0gm-1.0-35b-a3b` (`DEFAULT_0G_WORKER_MODEL`) | `0g:0gm-1.0-35b-a3b` |
| `openai` | The provider's own OpenAI-compatible server at `PROVIDER_MODEL_URL` (Ollama, vLLM, llama.cpp, LM Studio) | `PROVIDER_MODEL`, default `qwen2.5:3b-instruct` | `openai:qwen2.5:3b-instruct` |

- **No fallback:** a provider runs exactly what it declares. A `0g` provider without `ZEROG_API_KEY`, or an `openai` provider whose server is down, fails to start instead of quietly running something else.
- There is no keyword model in the product any more; the deterministic `heuristic` backend lives only in the test harness (`test/support/heuristic.ts`).
- `prompt.ts` builds the prompt and parses model output; `validate.ts` checks format; `compare.ts` scores agreement per task kind (`classify`: exact label; `tag`: Jaccard ≥ 0.5; `extract`: share of matching fields).
- Admission probes are scored against **true labels**, and canaries against a different 0G model (`glm-5.3`), so a provider running on 0G isn't being checked against itself.

### 8.11 Sign in with 0G — `web/src/zerog.tsx`
- Uses 0G's shared Privy app (`VITE_PRIVY_APP_ID`; only works on localhost 3000/3001/5173 — which is why Vite is pinned to 5173).
- Privy token → `POST /v1/auth/privy` session → `GET /v1/account/balance` shows the user's credits.
- **"Pay my agent with my credits"** creates a 24-hour API key on the user's account (`POST /v1/api-keys`) and hands it to the buyer agent (`POST /zerog-key`), so the user's credits pay for their agent's 0G calls.
- Fallback without Privy: paste a 0G management key (`mk-…`).

### 8.12 Provider ranking — `src/agent/ranking.ts`
Every eligible offer gets a score from 0 to 1, built from three signals the buyer can check:

| Signal | How it's measured |
|---|---|
| Price | Cheapest eligible quote ÷ this quote |
| Reliability | `(pass + 1) / (pass + fail + 2)` from the verifier's reputation entity on Arkiv. A newcomer starts at 0.5 |
| Speed | Fastest known median latency ÷ this provider's (unknown = typical) |

| Strategy | Price | Reliability | Speed |
|---|---|---|---|
| `cheapest` | 0.6 | 0.3 | 0.1 |
| `balanced` (default) | 0.4 | 0.4 | 0.2 |
| `fastest` | 0.15 | 0.35 | 0.5 |

`AGENT_MAX_PROVIDERS` limits how many work at once; the next best wait as reserves and step in when one drops out. `AGENT_MIN_RELIABILITY` skips providers with a poor record once they have 5+ checks. The dashboard's Run page sets the strategy and provider count per job. Scores show in the printed report, the agent's run list and the passport.

### 8.13 Compute Passport — `src/agent/passport.ts`, `scripts/verify-passport.ts`
A public, signed JSON record of one job (`kind: kinetic.passport.v2`, schema `docs/compute-passport.schema.json`) on 0G Storage. It holds no input data and no keys. Older `v1` passports still check.

- **v2 adds:** per-chunk `authenticity` (where and how it ran: `0g-direct`, `0g-router` or `self-hosted`, the 0G node, the guarantee `TeeML` / `TeeTLS` / … / `none`, and the verifier's own TEE check) and `correctness` (known answer, independent copies, canary or format only), kept as separate questions (`src/agent/assurance.ts`); an `inputCommitment` per chunk (an HMAC only the buyer can open); the known-answer commitment and reveal; the assurance tier; the PRNG spot checks; the Merkle anchor with each chunk's proof; slash outcomes and signers; and a `summary` derived from the chunks, which checkers recompute.

- **Contents:** the job, task and buyer (address + UAID); `output.resultsHash`; `work` (per chunk: provider, item count, signed result hash, provider signature, payment tx, amount, and `verified`/`format`); `canaries` (commitment, reveal, salt, every scored canary with its 0G request id); `coverage`; `policy`; `providers` (declared model, GPU, UAID, `adversarial` label if any, rank, admission, status, paid, refund, slash tx); `references` (topic, mirror, vault, gateway); and `limitations` (what it does not prove).
- **Signatures:** the buyer signs `sha256(canonicalJson(body))`. The verifier co-signs the same digest only after checking the parts it recorded itself: the canaries, each chunk's provider, hash and payment, the slashes, the fee and the policy (`Verifier.attest`). If it refuses, the passport records why.
- **Checking it:** `npm run passport:verify -- <0G root | file> --results out/<jobId>.json [--offline]`.
  - Offline: the schema, both signatures, the canary and known-answer reveals against their commitments, each provider's signature on its result hash, that every authenticity and correctness claim and the summary follow from the evidence, every canary's 0G TEE signature, each chunk's Merkle proof under the anchored root, the spot picks recomputed from the seed, that spending stayed within the firm quote, and that the results file matches each signed chunk hash.
  - Online (skip with `--offline`): the job, chunk, reveal, spot, anchor and slash receipts on HCS (paging through the topic), payments on the mirror node, each slash's status in the vault and that the co-signer is one of the vault's verifiers, that each canary's TEE signer is the one 0G's serving contract registers (`--zg-rpc` overrides the 0G mainnet RPC), and the passport itself fetched by its 0G root and its bytes checked against that root.
  - Agreement: the hash in the HCS job receipt matches, the agreed check rate was met, every verified chunk scored at least the pass mark, and the stated outcome matches the work.

### 8.14 Job agreement — `src/core/agreement.ts`
The rules a buyer sets before any chunk runs:

| Rule | Field | Default | Set with |
|---|---|---|---|
| Share of chunks checked against 0G | `canaryRate` | network `CANARY_RATE` | `--check-rate`, dashboard |
| Pass mark for a checked chunk | `minAgreement` | network `CANARY_MIN_AGREEMENT` | `--pass-mark`, dashboard |
| Admission examples and accuracy | `admission` (`source`, `size`, `hash`, `minAccuracy`) | the verifier's examples | `--gold <jsonl>`, `--min-accuracy` |
| Budget | `budget` | the buyer's `maxJobSpend` / `maxPricePerChunk` | existing settings |
| Deadline | `deadline` (ISO) | none | `--deadline <s>`, dashboard |

- **Can't go below the network:** `makeAgreement` raises anything lower to the verifier's policy, and the verifier refuses an agreement that is lower, doesn't match the task, or doesn't match the examples sent (`agreementProblems`).
- **Two bars, on purpose:** a canary below the buyer's pass mark is not accepted (redone elsewhere), but only a result below the *network's* bar counts against the provider and toward slashing. A buyer can't get honest providers slashed by setting a high bar.
- **Private examples:** the verifier receives the buyer's examples privately and probes providers with them for that job only (results stay off public reputation). Only their hash and count are published.
- **Locked and checked:** the agreement's hash goes in the HCS `job` receipt; the passport carries the public form and the `outcome` (met, or why not); the verifier won't co-sign a passport whose agreement differs.
- **Deadline:** after it, no new paid work starts; the job closes as incomplete and the outcome says "the deadline passed".
- **Firm quote** (`src/core/quote.ts`): before work, the buyer discovers offers first and prices the job: (chunks + 25% reroute allowance, at least one) × the highest price among the providers that might work, plus the verifier's fee as the verifier computes it (`verifierFee`, shared by both). The quote is in the agreement, `budget.maxSpend` is never above it, and the agent stops paying once the next payment would cross it. The verifier rejects a quote whose fee differs from its charge; the outcome notes "paid X of the Y quoted"; `passport:verify` checks every provider's payments plus the fee stay within it.

### 8.15 Model check (fingerprinting) — `src/core/fingerprint.ts`, `scripts/fingerprint.ts`

- **Idea:** capable models agree on clear-cut tickets but split on borderline ones, and each model answers a borderline ticket the same way run after run. Those answers fingerprint the model.
- **Building it:** `npm run fingerprint` runs real models on `data/fingerprint-candidates.jsonl` (40 borderline tickets) twice each, keeps each model's stable answers, and picks the 12 items per model that the most other models answer differently. Measured: 10 0G models plus local `qwen2.5:3b-instruct`; output in `data/fingerprints.json`.
- **Checking:** after a provider passes admission on the verifier's examples, the verifier reads the backend its offer declares, pays it for two normal-looking 6-item chunks of that model's probe items, and compares the answers with every known model's. Verdict, from the declared model's match only: consistent at ≥75%; mismatch below 60%; inconclusive in between, on too few answers, or on an error. The closest other model is shown but doesn't decide: similar large models share answers, and an earlier "another model matches better" rule wrongly flagged honest `atlas` on testnet.
- **Measured:** honest `0gm-1.0-35b-a3b` 75–100% (scripted runs and live testnet probes); claiming 0gm while running `qwen2.5:3b` 50%; never calling a model 33%. On 0gm's items, `qwen3.5-flash` matches 100% and `deepseek-v4-flash` 90%, so similar large models are indistinguishable.
- **Recorded, never enforced:** HCS `fingerprint` receipt; reputation attributes `fp_status`, `fp_match`, `fp_model`, `fp_closest`; the provider's admission entry in the report and passport; a "Model check" line on the Providers page. Statistical, gameable by a provider that runs the declared model only on guessed probes, and shifted by model updates, so it never slashes. Rebuild it when providers' models change.

### 8.16 Known answers — `src/verifier/known.ts`, `data/tasks/`
- **Ground truth in every chunk:** at registration the verifier plants one of its labelled examples in every chunk, at a random position under an id that looks like the buyer's own, and re-encrypts the chunk. It commits to where it planted them (`known` in the HCS `job` receipt) and reveals that at the end (`reveal`). The planted items are removed from the buyer's results.
- **What slashes:** only known-answer misses, malformed output and contradicted 0G execution records count toward slashing. Disagreeing with the 0G reference fails the chunk but doesn't slash (unless `CANARY_MODEL_SLASHES=true`), because two good models can read an ambiguous item differently.
- **Ten tasks** have labelled sets: the original ticket set (`data/classify-tickets.task.json`, `data/gold-tickets.jsonl`) and nine folders in `data/tasks/` (`task.json`, `gold.jsonl`, `items.jsonl`): `classify-tickets`, `sentiment`, `language`, `news-topic`, `spam`, `intent`, `animal-class`, `ticket-tags`, `ticket-fields`, `invoice-fields`. Other tasks get format, execution and model checks only, and the passport says no known answers were planted.
- **Kept apart from admission:** each set (24–36 items) is split in two; admission probes use one half and planting the other, so a provider that logged its probes can't spot planted items.
- **Calibrated:** `npm run gold:check` keeps only items both the providers' 0G model and the reference model answer exactly as labelled (`--write` drops the rest), so an honest provider is never slashed over an ambiguous item.

### 8.17 ERC-8004 on 0G Chain — `src/integrations/erc8004.ts`
- The verifier and every GPU register as Trustless Agents in the Identity Registry on 0G Galileo (an ERC-721: each owns its agent id), with an agent card naming its endpoints and how it can be trusted. A provider's offer carries its `agentId` and registration tx.
- After each job, the verifier gives each GPU feedback in the Reputation Registry: the share of the job's hidden checks it passed, with the evidence attached, plus a record of any executed slash. The registry refuses feedback from an agent's own owner, so a GPU can't rate itself.
- The GPUs page reads the averages back from 0G. Settings: `ERC8004_*` (§14).

### 8.18 PRNG spot checks and the Merkle anchor — `src/core/spot.ts`, `src/core/merkle.ts`
- **Why after the job:** canaries must stay secret until the reveal, so they can't come from a public seed. Instead, once the reveal is on HCS and every result is signed and receipted, the verifier draws one seed per job from Hedera's PRNG through the vault (`drawSeed`, HIP-351). The seed picks `SPOT_CHECKS` chunks (default 1) to re-run on 0G: a Fisher-Yates draw where step *i* uses `sha256(seed | jobId | i)`. Nobody could know the picks during the work, the vault allows one draw per job, and anyone can recompute them. Results go in a `spot` receipt and the passport; a disagreement is recorded but doesn't slash.
- **One anchor per job:** the verifier hashes each finished chunk's record (`kinetic.chunk.v1`, canonical JSON, SHA-256) into a Merkle tree, in the format of Hedera's "Batch, anchor, and verify records with HCS" tutorial, and posts the root as one `hcs.merkleRootAnchor` message. Each chunk in the passport carries its proof, so one record can be checked without the others.

### 8.19 Model hub — `src/models/`, `src/verifier/models.ts`
- **Model card** (`card.ts`): id, exact version, task (labels or fields), runtime (`0g` for a model 0G serves, `openai` for one providers load on their own GPU), weights with their sha256 and where they are, licence, and a royalty of 0–30% of provider payments. The creator signs it, so nobody can list a model in their name or redirect its royalties; new terms mean a new version.
- **Publishing** (`publish.ts`, `npm run kinetic -- models publish --card card.json [--weights <folder>]`, or the dashboard's Publish page): the malware checks run on the creator's machine first (`.safetensors` only, headers validated, no pickle or custom code; `safetensors.ts`). The weights go to 0G Storage (multi-GB files, addressed by Merkle root) unless the card names a source URL, and the creator pays the verifier's listing fee over x402 (`MODEL_LISTING_FEE_TINYBAR`, 0.01 ℏ).
- **Review** (`review.ts`): each verifier reviews on its own: downloads and re-checks the weights, runs the benchmark (`MODEL_BENCHMARK_ITEMS`, at least `MODEL_MIN_ACCURACY` 0.7) and the fingerprint, and signs only if it reaches the same answers as the lead. With a quorum, the listing verifier stores the Model Passport on 0G Storage (the listing's `passportRef` is its root), its digest goes to HCS (`model` receipt), and a `model` listing to Arkiv. Only a vault verifier can write a listing, and the desk renews it before it expires.
- **Running:** providers download the weights once, check each file's sha256 against the card before loading (`weights.ts`), and declare `weightsChecked` in their offer.
- **Royalties:** after a model job, the buyer pays the creator their share of the accepted chunk payments over x402 (`POST {verifier}/jobs/:id/royalty`, straight to the creator), recorded in a `royalty` receipt. The firm quote includes the most the royalty can be.

### 8.20 Assurance tiers — `src/core/tiers.ts`
| Tier | What runs | Verifier fee |
|---|---|---|
| `basic` | signed receipts, format and execution checks; no canaries or known answers | 20% of standard |
| `standard` (default) | known answers in every chunk, hidden 0G canaries | standard |
| `high` | standard, and every chunk run by two independent providers whose results must agree; a disagreement goes to a third and the majority wins (`redundant` receipts) | 150% |
| `confidential` | standard, only on 0G Compute services whose TEE (TeeML on a 0G node, not a TeeTLS relay) signs every response; any chunk whose attestation doesn't verify is rejected | 125% |

The tier is part of the job agreement. `confidential` proves where the model ran; it doesn't hide the data from the KINETIC provider's own process.

### 8.21 0G Compute direct and 0G Storage — `src/integrations/zerog-compute.ts`, `src/integrations/zg-storage.ts`
- **Direct 0G Compute:** instead of the router (where the router picks the node), a provider can bind to one 0G Compute service (an on-chain address in the inference serving contract), send each chunk to that service's endpoint, and return the chat id its TEE signed with the exact response bytes. Anyone can then check the signature against the registered TEE signer without trusting the KINETIC provider that relayed it. This is what the `confidential` tier needs.
- **0G Storage:** model weights and passports (§8.8) are uploaded with an on-chain `submit` to 0G's Flow contract (a funded 0G wallet pays the storage fee) and addressed by the Merkle root of their contents; downloads need no wallet. The SDK's "download with proof" flag doesn't verify anything yet, so every download is checked here by recomputing the root.

---

## 9. Trust and security model

| Threat | Defence | Where |
|---|---|---|
| Provider returns junk / skips the model | Admission probe (ground truth), format checks, hidden canaries vs 0G, slash | `verifier.ts` |
| A provider claims compute it doesn't have | It must declare its backend and model in its offer (e.g. `0g:0gm-1.0-35b-a3b`) and runs exactly that, with no fallback; whatever it really runs must still pass the admission probe, format checks and hidden canaries. This catches skipped or wrong work, but does **not prove** which model or hardware ran | `provider/backend.ts`, `verifier.ts` |
| Provider detects canaries and behaves only on them | Canaries are normal chunks of the buyer's own data, identical requests; probes use random-looking ids | `core/canary.ts`, `verifier.probe` |
| Verifier picks canaries after seeing results | Commit hash on HCS before work; reveal at the end | `core/canary.ts`, HCS `job`/`reveal` |
| Rules changed after seeing results | Agreement hash in the HCS `job` receipt before work; checked by the passport and its verifier | `core/agreement.ts` |
| Buyer sets an extreme bar to get providers slashed | Buyer's pass mark only decides acceptance; slashing uses the network's bar | `verifier.judge` |
| Tampered job record | Compute Passport signed by buyer and verifier; any edit breaks the signatures | `agent/passport.ts` |
| Buyer forges bad results to frame a provider | Providers sign `{jobId, idx, resultHash}`; verifier checks signature | `util/sign.ts` |
| Buyer inflates refund | Refund sized from mirror-node credited amount, not buyer's claim; one slash per job; a slash needs a quorum of verifiers, each re-checking the evidence | `mirror.ts`, vault |
| Someone publishes an offer for another provider | Arkiv owner must equal `provider` attr; HCS-14 UAID must match profile and pay-to account | `buyer.discover` |
| Provider withdraws bond before a slash | Withdraw timelock; buyers skip any provider with a withdrawal pending | vault, `buyer.discover` |
| Verifier restarts mid-job | Open jobs (canary plan, salt, payments, fee) are saved under `KINETIC_STATE_DIR` and restored; each provider's slash window is kept on its Arkiv reputation | `verifier.ts` |
| Payment header replayed after a restart | Used headers are saved and shared across the verifier's fee gates | `x402.ts` (`ReplayGuard`) |
| Refund exceeds bond | Buyer never spends more at one provider than its bond | `buyer.ts` (`capped`) |
| Provider is charged / buyer is charged for failed work | Settle only after work succeeds | `x402.ts` |
| Payment replay | Header hash tracked; facilitator verification | `x402.ts` |
| Provider takes payment and vanishes | Buyer knows the payment tx id, checks ledger, reports "undelivered" | `buyer.ts` reconciliation |
| Data leakage | Per-chunk keys via HKDF; no chunk data on Arkiv or any public store; provider gets one chunk key inside a paid request; verifier gets the job key only to open canaries | `util/crypto.ts` |
| Unauthenticated calls to the verifier | Every job/result call is signed with a 5-minute timestamp window | `util/sign.ts`, `verifier/service.ts` |
| Arkiv API key exposure in browser | Dashboard reads Arkiv via verifier's cached `GET /arkiv/:kind` | `verifier/service.ts` |
| Provider answers known items right and cuts corners on the rest | Known answers are planted in every chunk under ids like the buyer's own; admission and planting use separate halves of the labelled set | `verifier/known.ts` |
| Verifier picks spot checks to suit itself | Picks come from one Hedera PRNG seed per job, drawn in the vault only after the reveal; anyone can recompute them | `core/spot.ts`, vault `drawSeed` |
| One verifier slashes on its own word | A slash needs a quorum of the vault's verifiers, each re-running the failed checks with its own 0G credits; the provider can dispute | `verifier/cosigner.ts`, vault |
| A canary's 0G run is faked or misattributed | The verifier checks the TEE signature itself against the signer in 0G's serving contract, not the router's word | `integrations/zerog-tee.ts` |
| A model file runs code when loaded | Only `.safetensors` is accepted, headers are validated, and the malware checks run before upload and again in every verifier's review | `models/safetensors.ts`, `models/review.ts` |
| Tampered or swapped weights | The signed card pins each file's sha256; providers and verifiers check it on every download, and 0G Storage downloads are re-checked against their root | `models/weights.ts`, `zg-storage.ts` |
| Someone lists a model in another's name or redirects royalties | The creator signs the card; only a vault verifier can write a listing, after a quorum signs the Model Passport | `models/card.ts`, `models/registry.ts` |
| A GPU rates itself on ERC-8004 | The Reputation Registry refuses feedback from an agent's own owner | `integrations/erc8004.ts` |

---

## 10. Money: who pays whom, and how refunds work

**Units:** 1 HBAR = 100,000,000 tinybar (ℏ). Code uses `bigint` everywhere for amounts.

| Flow | From → To | When | Amount (defaults) |
|---|---|---|---|
| Bond | Provider → Vault | At provider start-up | `PROVIDER_BOND_TINYBAR` (1 ℏ) |
| Verification fee | Buyer → Verifier (x402) | Job registration | 10,000 tinybar (0.0001 ℏ) × chunks |
| Admission probe | Verifier → Provider (x402) | Before job work | Provider's price (cap 0.01 ℏ) |
| Chunk payment | Buyer → Provider (x402) | Each chunk, settled on success | Provider's price (e.g. 0.001 ℏ) |
| Refund | Vault (provider's bond) → Buyer | When the slash executes, after the dispute window | Exactly the HBAR the buyer paid that provider in this job, capped at bond; the rest of the bond is burned |
| Challenge bond | Provider → Vault | On a dispute | At least `minChallenge`; returned if the slash is overturned, paid to the buyer if upheld |
| Listing fee | Creator → Verifier (x402) | Publishing a model | `MODEL_LISTING_FEE_TINYBAR` (0.01 ℏ) |
| Royalty | Buyer → Creator (x402) | After a model job | The card's `royaltyBps` (0–30%) of the accepted chunk payments |
| 0G usage | Verifier's 0G credits → 0G | Each canary reference run and spot check | Per 0G pricing |

**Net cost to buyer** = paid to providers − refunds + verifier fee (+ royalty on a model job). The verifier fee scales with the assurance tier (§8.20) and the agreed check rate. Payments and bonds are both HBAR, so a refund needs no exchange rate.

Example from the HBAR testnet run `job-mvsji5xu-9915f8` (§18; 60 tickets, 20 chunks):
```
providers paid 0.026 ℏ · refunded 0.0036 ℏ · verifier fee 0.002 ℏ · net 0.0244 ℏ
```

**Spending controls on the buyer:** max price per chunk (`AGENT_MAX_PRICE_TINYBAR`), max job spend (`AGENT_MAX_JOB_SPEND_TINYBAR`), optional provider allowlist (`AGENT_ALLOWLIST`), and a kill switch (`POST /halt`, "Stop all paid work" button).

---

## 11. The dashboard (web app)

Vite + React app in `web/`, hash-routed. Live state comes from `web/src/live.tsx` polling `web/src/data.ts`, plus Arkiv changes pushed by the verifier over Server-Sent Events (`GET /arkiv/events`). **Every number comes from a public source** (Arkiv, HCS via the mirror node, the verifier's evidence); nothing is scripted. The one exception is the opt-in, labelled synthetic replay (`?replay`, `web/src/replay.ts`). The visual design is in `DESIGN.md`.

The header has two toggles, **Models** and **Console**:

| Route | File | Shows |
|---|---|---|
| `#/` | `pages/Landing.tsx` | What KINETIC is and how a job is checked, with a model search; no live figures, so it loads before the network answers |
| `#/models`, `#/models/<key>` | `pages/Models.tsx`, `pages/TryIt.tsx` | The model hub: a card per listed model (benchmark, GPUs serving, jobs, runtime, where the weights live, royalty); each model page has its Model Passport and a **Try it** run |
| `#/console` … | `console.tsx` | A full-screen, IDE-style workspace: activity bar, explorer (jobs, GPUs, models, creators), tabs, Activity / Problems panel, status bar, command palette (`Ctrl`/`⌘` `K`). Every page below opens inside it |

| Console page | File | Shows |
|---|---|---|
| Overview (`#/console`) | `pages/Overview.tsx` | Live totals, recent jobs, live activity |
| Run (`#/run`) | `pages/Run.tsx` | Model or task, ticket count, chunk size, max price, budget, assurance tier, provider choice (strategy, providers at once), job rules (checked %, pass mark %, deadline), firm quote from live offers, kill switch; each run shows provider scores, whether the agreement was met, and its passport |
| Jobs (`#/jobs`, `#/jobs/<id>`) | `pages/Jobs.tsx` | Job list; job detail in numbered stages: admission, chunk grid, x402 payments, canaries vs 0G (with diffs and 0G request ids), slashes, reroutes, settlement, evidence (Compute Passport, spot checks, Merkle anchor, and its verify command). HashScan links |
| GPUs (`#/providers`) | `pages/Providers.tsx` | A card per provider, live first: status edge, price, bond, latency, earnings, checks passed and the model it serves; a **test** badge on adversarial test providers; **Details** adds admission, model check, reputation (Arkiv and ERC-8004), identity and sandbox |
| Publish (`#/publish`) | `pages/Publish.tsx` | Publish a model: card, weights, malware checks, verifier review and listing |
| Creators (`#/creators`) | `pages/Creators.tsx` | A creator's models and royalty payments |
| Earn (`#/earn`) | `pages/Earn.tsx` | Publish a model or rent out a GPU (old `#/provide` links land on its provider tab) |
| Audit trail (`#/audit`) | `pages/Audit.tsx` | Every HCS receipt, filterable by type |
| Docs (`#/docs`) | `pages/Docs.tsx` | Get started and the verifier API |

Amounts are shown in HBAR. Old HCS receipts that carry an `asset` field (from earlier KUSD jobs) are still labelled in that token, so history reads correctly.

Shared UI: `ui.tsx`; styles in `styles.css`, `theme.css`, `pages.css`, `product.css` and `design.css` (loaded last). Both the website header and the console's title bar have the **Sign in with 0G** account widget.

Config (`web/.env`): `VITE_VERIFIER_URL` (default `http://localhost:4500`), `VITE_AGENT_URL` (default `http://localhost:4600`), `VITE_PRIVY_APP_ID`.

---

## 12. Test harness (devnet)

The devnet is **only the automated tests' harness** — it is not part of the product and can't be used to run KINETIC. It lives in `test/support/`:

| File | What it is |
|---|---|
| `test/support/devnet.ts` | `startDevnet()`: the emulator of every external network, plus `ensureDevnetFunds` |
| `test/support/scenario.ts` | `runScenario()`: the full five-provider scenario (old provider names `atlas-4090` … `shoddy-1060`) used by the end-to-end tests. Options for a verifier quorum (cosigners, lenient ones, disputes), known answers, spot checks, assurance tiers, direct 0G Compute providers (incl. tampering), and the model hub (`modelHub`: publish, serve, royalty) |
| `test/support/heuristic.ts` | `HeuristicBackend`: deterministic keyword model, so the tests' results are checkable |
| `test/support/evm.ts` | `TestChain`: an in-process EVM (EthereumJS) that runs the compiled `KineticBondVault` as real bytecode with a test-controlled clock, and stand-ins for Hedera system contracts (schedule, PRNG) |

`loadNetworkConfig` throws on `KINETIC_NETWORK=devnet` unless it is running under the test runner (Vitest), and the devnet client adapters in `src/integrations/` are reachable only from tests. There is no `npm run devnet` or `npm run demo` any more.

The emulator runs every external network on one Express server (the scenario starts at port 4400):

| Real thing | Devnet route |
|---|---|
| x402 facilitator | `/facilitator/supported`, `/verify`, `/settle`, `/settled/:nonce` |
| Hedera mirror node | `/mirror/api/v1/transactions/:id`, `/mirror/api/v1/topics/:topic/messages` |
| HCS submit | `/devnet/hcs/:topic/messages` |
| Bond vault | `/devnet/vault/...`: `info`, `bonds/:address`, `slashes/:id`, `burned`, `seeds/:tag`; `bond`, `request-withdraw`, `propose`, `dispute`, `resolve`, `execute`, `seed` (quorum-signed, once-per-job slashing, dispute window and burns, PRNG seeds, as the contract) |
| Arkiv | `/arkiv/create`, `/patch`, `/extend`, `/delete`, `/query`, `/get`, `/events` (ownership, expiry, 128-byte cap enforced) |
| 0G router | `/0g/v1/chat/completions`, `/0g/v1/account/balance` |
| 0G Compute | `/0gc/services`, `/0gc/p/:provider/v1/proxy/chat/completions`, `/0gc/p/:provider/v1/proxy/signature/:chatId` (providers with their own TEE signers) |
| 0G Storage | `/zgs/upload`, `/zgs/file`, `/zgs/:root` |
| Faucet | `/devnet/faucet`, `/devnet/accounts/:address` |

It speaks the real wire formats where cheap, so the tests drive the same client code. It is test scaffolding only: no consensus, no persistence. Payments use network id `kinetic:devnet` with EIP-191 signed authorizations.

---

## 13. Running the project

### 13.1 Real testnets (the only way to run KINETIC)
There is no offline demo: KINETIC runs on the real testnets, with `npm run live` (one job) or `npm run live -- --serve` (dashboard), or one role at a time with `npm run verifier|cosigner|provider|agent`. Outside users (one buyer or one provider, not the whole network) use `npm run kinetic -- <command>` or the SDK (§13.3).

You need: one Hedera testnet ECDSA account (portal.hedera.com), one Arkiv wallet with gas (hub.arkiv.network/faucet), ideally an Arkiv access key, and a 0G Private Computer API key with credits (pc.0g.ai) — the verifier's reference runs and the providers' work (`PROVIDER_BACKEND=0g`) both run on 0G. The verifier's 0G on Galileo (sent by `setup:testnet`, `ZG_GAS_VERIFIER`) also pays the 0G Storage fees for passports.

```bash
cd KINETIC
npm install
npm --prefix web install         # once, for the dashboard

# 1. Create all roles (verifier, verifier-2/-3 cosigners, buyer, creator, provider-1…5),
#    HCS topic and vault; writes .kinetic/testnet/<role>.env
OPERATOR_ID=0.0.xxxx OPERATOR_KEY=0x... ARKIV_FUNDER_KEY=0x... ARKIV_API_KEY=... ZEROG_API_KEY=... \
  npm run setup:testnet

# 2. Read-only preflight checks
npm run doctor

# 3a. One real job end to end, writes out/live-<jobId>.md with explorer links
npm run live

# 3b. Or keep the network up and start jobs from the dashboard
npm run live -- --serve          # add --job to also run one at startup
npm run web
```
- `npm run live` starts the two cosigning verifiers (ports 4510, 4520), the lead verifier, and the five providers of §4 (`src/testnet/roles.ts`): `BluePeak` and `Riverstone` (honest) and the adversarial test providers `QuickCompute` (`degrade-after:3`), `EdgeRelay` (`offline-after:5`) and `BudgetGPU` (`lazy`), all on 0G Compute except `BudgetGPU`, which never calls a model. (Runs before 2026-11-01 named them `atlas`, `nimbus`, `cheapo`, `flicker`, `shoddy`.) With a `creator` role it also publishes every card in `data/models/` that isn't listed yet; `--model <id>` runs the job on a listed model.
- Slashing is permanent per address. `QuickCompute` (`provider-3`) is the provider that gets slashed, so once it has been, give it a fresh key and account to see a slash again: `npm run setup:testnet -- --rotate provider-3`.
- Direct 0G Compute (optional): `PROVIDER_BACKEND=0g-compute` binds a provider to one 0G Compute provider (`ZG_PROVIDER_ADDRESS`); `npm run zerog -- providers|assign|plan|fund|status` lists, assigns and funds them.
- Own model server (optional): set `PROVIDER_BACKEND=openai` and `PROVIDER_MODEL_URL` (e.g. Ollama: `ollama pull qwen2.5:3b-instruct`, `PROVIDER_MODEL_URL=http://localhost:11434/v1`). The provider then runs only that server — if it is down, the provider fails to start. Run `npm run calibrate` first to measure its accuracy and agreement with 0G and get a suggested `CANARY_MIN_AGREEMENT`.

### 13.2 All npm scripts

| Script | Runs | Purpose |
|---|---|---|
| `live` | `src/live.ts` | Full scenario on real testnets (`--serve`, `--job`, `--items`, `--chunk`, `--task`, `--model`, `--canary-rate`; job rules `--check-rate`, `--pass-mark`, `--gold`, `--min-accuracy`, `--deadline`, `--tier`, also on `agent`) |
| `kinetic` | `src/cli/kinetic.ts` | One CLI for outside users: `init`, `status`, `run --task\|--model`, `models [list\|show\|publish]`, `provider`, `tasks` (§13.3) |
| `passport:verify` | `scripts/verify-passport.ts` | Check a Compute Passport (`<0G root or file> --results <report> [--offline] [--indexer] [--mirror] [--zg-rpc]`); a root is fetched and its bytes checked against it |
| `passport:schema` | `scripts/passport-schema.ts` | Write the Compute Passport v2 JSON Schema to `docs/compute-passport.schema.json` |
| `setup:testnet` | `scripts/setup-testnet.ts` | Bootstrap all roles/resources, incl. 0G gas for ERC-8004 (`--rotate <role>`) |
| `doctor` | `scripts/doctor.ts` | Preflight: balances, aliases, topic, vault verifiers, quorum and HIP-1215, cosigners, every facilitator, 0G Storage (indexer reachable, verifier has 0G for fees), 0G, Arkiv gas |
| `calibrate` | `scripts/calibrate.ts` | Measure a provider's own model vs known answers and 0G (`--url`, `--model`, `--chunks`, `--size`, `--task`) |
| `gold:check` | `scripts/gold-check.ts` | Run every labelled item through real 0G models; `--write` drops ones a model disagrees with (`--models`, `--task`) |
| `fingerprint` | `scripts/fingerprint.ts` | Measure real models on borderline tickets and write `data/fingerprints.json` (`--models`, `--runs`, `--ollama`) |
| `zerog` | `scripts/zerog.ts` | 0G Compute for `PROVIDER_BACKEND=0g-compute`: `providers`, `assign`, `plan`, `fund`, `status` (`--yes` to write/send) |
| `bonds` | `scripts/bonds.ts` | Role bonds in current and earlier vaults: `status`, `request`, `withdraw` (`--yes`, `--vault`, `--role`, `--keys`) |
| `migrate:passports` | `scripts/migrate-passports.ts` | One-time move of existing Model Passports to 0G Storage (dry run by default, `--apply` to execute; stop `npm run live` first) (§8.8) |
| `register:hol` | `scripts/register-hol.ts` | List a provider in the Hashgraph Online registry (HCS-10); writes `HOL_INBOUND_TOPIC_ID` (`--role`) |
| `verifier` / `cosigner` / `provider` / `agent` | `src/verifier/server.ts`, `src/verifier/cosigner-server.ts`, `src/provider/server.ts`, `src/agent/cli.ts` | Run one role as its own process |
| `keys` / `create:topic` / `deploy:vault` | `scripts/*` | Manual alternatives to `setup:testnet` (`deploy:vault -- --compile-only`) |
| `smoke:hedera` | `scripts/smoke-hedera.ts` | Quick check against Hedera testnet (x402, mirror, HCS, vault slash) with a throwaway provider |
| `test` / `typecheck` | vitest / `tsc --noEmit` | Tests and type checking |
| `web` | `web/` Vite dev server | Dashboard |

`scripts/make-dataset.ts` (no npm script: `npx tsx scripts/make-dataset.ts`) generates `data/tickets.jsonl` and `data/gold-tickets.jsonl`.

### 13.3 As one buyer or provider (CLI and SDK)

`npm run kinetic -- init buyer|provider` creates a key, Hedera account and Arkiv gas and writes `.kinetic/buyer.env` or `.kinetic/provider.env` (it never reads the repository's `.env`); `status` checks them; `run --task <name>` runs a paid, verified job; `provider` starts a provider node. Network values default to `TESTNET` in `src/networks.ts`. From code: `new Kinetic({ privateKey, hederaAccountId })` from `src/sdk/index.ts` (`run`, `providers`, `models`, `model`, `passport`, `publish`, `halt`/`resume`, static `tasks`; see `docs/USE_KINETIC.md`). A sandboxed Ollama for providers: `docker/ollama-sandbox.compose.yml`.

---

## 14. Configuration reference

All settings come from environment variables, read by `loadNetworkConfig` / `identityFromEnv` in `src/config.ts`. Entry points import `src/env.ts` first, which loads a local `.env` into the environment (library code never does, so an embedding app keeps control). `.env.example` documents every one. Each role on testnet gets its own file in `.kinetic/testnet/`; `npm run kinetic` uses `.kinetic/buyer.env` / `.kinetic/provider.env` instead.

| Group | Variables | Notes |
|---|---|---|
| Network | `KINETIC_NETWORK` | `testnet` (default). `devnet` is accepted only inside the test runner |
| Identity | `KINETIC_PRIVATE_KEY`, `HEDERA_ACCOUNT_ID` | One key per role |
| Setup inputs | `OPERATOR_ID`, `OPERATOR_KEY`, `ARKIV_FUNDER_KEY`, `ARKIV_FUND_PER_ROLE` (0.01), `ZG_GAS_VERIFIER` (0.1), `ZG_GAS_PER_PROVIDER` (0.015) | Only for `setup:testnet`. The `ARKIV_FUNDER_KEY` wallet also pays 0G gas for ERC-8004 |
| x402 / payment | `X402_FACILITATOR_URL`, `X402_FACILITATOR_URLS` | Quotes fail over down the list: `X402_FACILITATOR_URL` first, then x402.org, Blocky402, Launa; `X402_FACILITATOR_URLS` (comma-separated) replaces the whole list. A payment settles with the facilitator that quoted it. Payments are always HBAR; there is no asset setting (§8.5) |
| Hedera | `HEDERA_MIRROR_URL`, `HEDERA_JSON_RPC_URL` (`https://testnet.hashio.io/api`), `HCS_TOPIC_ID`, `BOND_VAULT_ADDRESS`, `VAULT_SCHEDULE_FEE_TINYBAR` | Schedule fee: what a slash proposal pays the vault to execute itself when the window closes (HIP-1215); default gas limit × gas price + 10%, `0` disables |
| Vault rules | `VAULT_VERIFIERS` (deployer), `VAULT_THRESHOLD` (majority), `VAULT_DISPUTE_THRESHOLD` (all), `VAULT_DISPUTE_WINDOW` (60 s), `VAULT_RESOLVE_TIMEOUT` (600 s), `VAULT_MIN_CHALLENGE_TINYBAR` (10000000), `VAULT_WITHDRAW_DELAY` (86400 s) | Read by `deploy:vault` only |
| Arkiv | `ARKIV_RPC_URL` (Rabdi), `ARKIV_CHAIN_ID` (7794095), `ARKIV_EXPLORER_URL`, `ARKIV_API_KEY`, `ARKIV_APP` (`kinetic`) | Chain id and explorer follow from the RPC URL. Change `ARKIV_APP` to isolate test runs |
| 0G router | `ZEROG_BASE_URL` (`https://router-api.0g.ai/v1`), `ZEROG_API_KEY`, `ZEROG_MODEL` (`glm-5.3`), `ZEROG_TRUST_MODE` (`verified`), `ZEROG_CANARY_TRUST_MODE` (`private`), `ZEROG_CANARY_FALLBACK` (`verified`, or `none`), `ZEROG_TEE_RPC_URL` (`https://evmrpc.0g.ai`) | `ZEROG_MODEL` is the verifier's reference model; it must have `verifiability` set. Canaries run TeeML-only and the verifier checks each one's TEE signature against the signer in 0G's serving contract on mainnet. A provider on `PROVIDER_BACKEND=0g` runs with its own `ZEROG_API_KEY` |
| 0G Compute (direct) | `ZG_PROVIDER_ADDRESS`, `ZG_PRIVATE_KEY` (role key), `ZG_RPC_URL` (`https://evmrpc-testnet.0g.ai`) | For `PROVIDER_BACKEND=0g-compute`: the 0G provider, and the wallet whose compute ledger pays |
| 0G Storage | `ZG_STORAGE_RPC_URL` (`https://evmrpc-testnet.0g.ai`), `ZG_STORAGE_INDEXER_URL` (`https://indexer-storage-testnet-turbo.0g.ai`) | Model weights, Compute Passports and Model Passports; uploads pay 0G's storage fee from the role's key (the verifier's, for passports) |
| ERC-8004 | `ERC8004` (`off` disables), `ERC8004_RPC_URL`, `ERC8004_CHAIN_ID` (16602), `ERC8004_IDENTITY_REGISTRY`, `ERC8004_REPUTATION_REGISTRY`, `ERC8004_EXPLORER_URL` | 0G's Identity and Reputation registries on Galileo; always off on devnet |
| Policy (verifier) | `CANARY_RATE` (0.25), `CANARY_MIN` (1), `CANARY_WINDOW` (10), `CANARY_FAIL_LIMIT` (3), `CANARY_MIN_AGREEMENT` (0.8), `KNOWN_ANSWERS` (true), `CANARY_MODEL_SLASHES` (false), `SPOT_CHECKS` (1; 0 on devnet), `VERIFIER_FEE_PER_CHUNK_TINYBAR` (10000), `VERIFIER_PORT` (4500) | Known answers are what slashing rests on; model disagreement only fails the chunk unless `CANARY_MODEL_SLASHES=true`. Spot checks re-run chunks on 0G picked by a Hedera PRNG seed drawn after the reveal. Tune with `npm run calibrate` |
| Quorum (verifier) | `VERIFIER_COSIGNERS` (comma-separated URLs), `SLASH_SETTLE_WAIT` (120 s), `COSIGNER_PORT` (4510) | The lead asks each cosigner to re-check and co-sign a slash; finalizing waits this long for dispute windows. A cosigner needs its own `ZEROG_API_KEY` |
| Labelled sets (verifier) | `GOLD_TASK`, `GOLD_SET`, `GOLD_DIR`, `FINGERPRINTS`, `FINGERPRINT_CANDIDATES`, `MODEL_FINGERPRINT_ITEMS` (24) | Defaults `data/classify-tickets.task.json`, `data/gold-tickets.jsonl`, `data/tasks`, `data/fingerprints.json`, `data/fingerprint-candidates.jsonl`. Cosigners need the same sets |
| Model hub (verifier) | `MODEL_MIN_ACCURACY` (0.7), `MODEL_BENCHMARK_ITEMS` (12), `MODEL_LISTING_FEE_TINYBAR` (1000000), `MODEL_MAX_DOWNLOAD_MB` (512), `VERIFIER_MODEL_URL`, `VERIFIER_MODEL_API_KEY` | Self-hosted (`openai` engine) models are benchmarked on `VERIFIER_MODEL_URL` |
| Provider | `PROVIDER_NAME`, `PROVIDER_PORT` (5101), `PROVIDER_PUBLIC_URL`, `PROVIDER_GPU`, `PROVIDER_TASKS` (`classify,extract,tag`), `PROVIDER_PRICE_TINYBAR` (100000), `PROVIDER_BOND_TINYBAR` (100000000), `PROVIDER_BACKEND`, `PROVIDER_MODEL_URL`, `PROVIDER_MODEL`, `PROVIDER_MODEL_API_KEY`, `PROVIDER_BEHAVIOR`, `PROVIDER_MODELS`, `PROVIDER_MODEL_IMPORT`, `PROVIDER_SANDBOX`, `HOL_INBOUND_TOPIC_ID` | `PROVIDER_BACKEND` is `0g` (default, 0G router with `ZEROG_API_KEY`), `0g-compute` (one 0G Compute provider, called directly) or `openai` (own server at `PROVIDER_MODEL_URL`, with optional `PROVIDER_MODEL_API_KEY`); `PROVIDER_MODEL` defaults to `0gm-1.0-35b-a3b` on `0g`. `PROVIDER_GPU` should be truthful, e.g. `0G Compute (TeeML)`. `PROVIDER_BEHAVIOR` is `honest` for a real provider; anything else (`lazy`, `flaky`, `offline-after:N`, `degrade-after:N`, `zg-down-after:N`) makes it an adversarial test provider that says so in its offer (§4). `PROVIDER_MODELS`: listed models to serve, each checked against its Model Passport first; `PROVIDER_MODEL_IMPORT=ollama` imports checked weights; `PROVIDER_SANDBOX` (e.g. `docker:no-network`) is declared in the offer. `HOL_INBOUND_TOPIC_ID` is set by `register:hol` |
| Buyer | `VERIFIER_URL`, `AGENT_MAX_PRICE_TINYBAR` (500000), `AGENT_MAX_JOB_SPEND_TINYBAR` (50000000), `AGENT_ALLOWLIST`, `AGENT_STRATEGY` (balanced), `AGENT_MAX_PROVIDERS` (all), `AGENT_MIN_RELIABILITY` (off), `AGENT_REQUIRE_ATTESTATION` (off), `AGENT_ALLOW_PLAIN_KEYS` (off) | Provider choice: §8.12. Require-attestation: only providers whose 0G Compute provider can be TEE-attested. Plain keys: also send unwrapped chunk keys to providers that publish no encryption key |
| Test harness | `DEVNET_URL` (`http://localhost:4400`) | Used only by the automated tests |
| State on disk | `KINETIC_STATE_DIR` | Default `.kinetic/testnet/state` on testnet, off in the test harness. Holds the verifier's open jobs (including job keys) and used payment headers: keep it private |

### Data files (`data/`)
- `classify-tickets.task.json` — the classification task: 6 labels with keyword hints.
- `extract-tickets.task.json` — an extraction task variant (3 fields).
- `tickets.jsonl` — 120 sample support tickets (the job input).
- `gold-tickets.jsonl` — 36 tickets with true labels (the labelled set for the ticket task: admission probes and planted known answers).
- `tasks/<task>/` — nine more built-in tasks, each with `task.json`, `items.jsonl` (18 sample inputs) and `gold.jsonl` (24 labelled examples): `animal-class`, `intent`, `language`, `news-topic`, `sentiment`, `spam` (classify), `invoice-fields`, `ticket-fields` (extract), `ticket-tags` (tag).
- `models/*.card.json` — ten model card drafts (`ticket-classifier`, `ticket-tagger`, `ticket-fields`, `invoice-extractor`, `intent-router`, `language-id`, `news-topic`, `review-sentiment`, `spam-filter`, `animal-class`) that `npm run live` publishes to the model hub.
- `fingerprint-candidates.jsonl` — 40 borderline tickets; `fingerprints.json` — each measured model's stable answers on them and the probes that tell models apart (`npm run fingerprint`).

---

## 15. Tests

`npm test` runs Vitest over 25 files (**206 tests**, per `npx vitest list`), all on the devnet emulator in `test/support/` (§12); `vault-contract.test.ts` runs the compiled contract in `test/support/evm.ts`. `npm run typecheck` runs `tsc --noEmit`.

| File | Covers |
|---|---|
| `test/core.test.ts` | Chunking, canary selection, commit/reveal, slash window and its saved form, scoring, prompt parsing, encryption, format validation; provider backends run exactly what they declare (0G Compute by default, no `heuristic` backend); `adversarial` labels appear only on non-honest behaviours; the firm quote (every chunk + reroute allowance at the highest price + the verifier's fee, more for more checks) |
| `test/integration.test.ts` | x402 gate: 402 quote, settlement, no charge on failure, budget refusal, replay rejection (also after a restart), lost-response reconciliation; Arkiv ownership and expiry |
| `test/x402-failover.test.ts` | Facilitator list (`X402_FACILITATOR_URL` first, `X402_FACILITATOR_URLS` replaces it), failover of quotes, settling with the facilitator that quoted; refuses an EVM payee or a window over 180 s |
| `test/verifier-restart.test.ts` | A restarted verifier finishes a saved job and reveals the committed canaries; dropped jobs stay gone; saved files are named by hash, never by the buyer's job id |
| `test/arkiv-queue.test.ts` | Write queue never strands a write and merges patches |
| `test/arkiv-live.test.ts` | Arkiv writes through named schemas with typed, selectively indexed columns; readonly checks; old entities still found; server-side sort and count; the live mirror follows entity events and streams to the dashboard over SSE |
| `test/identity.test.ts` | HCS-14 UAIDs and offer identity checks; payments are HBAR-only whatever the environment says; old HTS-token amounts still format and count when checking old passports |
| `test/provider-offer.test.ts` | Offer republished when it expired between heartbeats; a slashed provider refuses to start |
| `test/ranking.test.ts` | Ranking by price, track record and speed for each strategy |
| `test/wrap.test.ts` | Chunk keys wrapped to the provider's public key (ECIES): context-bound, fresh, tamper-evident |
| `test/passport.test.ts` | Passport detects edits, changed results, unbacked "verified" claims, a bad canary reveal, chunks below the pass mark, an overstated outcome; agreements never go below the network and must match what the verifier gets; passport v2 matches the published schema, keeps TeeML and TeeTLS apart, and catches claims beyond its evidence even when re-signed |
| `test/e2e.test.ts` | Full scenario (`test/support/scenario.ts`): correct labels, lazy provider kept out by known-answer qualification, cheating provider slashed and fully refunded, offline provider routed around, adversarial test providers shown as such without being routed on, firm quote committed and never exceeded, exact balance arithmetic, the passport is co-signed, stored on 0G Storage and passes every check, verifiable HCS trail; quarantine re-runs unverified chunks; reserves step in with `maxProviders: 2`; a buyer's stricter rules and own examples are committed, applied, charged for and met; a passed deadline stops paid work and is reported; a provider with a pending bond withdrawal gets no work |
| `test/known.test.ts` | Known answers: disjoint admission and planting halves, one planted per chunk under a buyer-like id and committed; misses slash the lazy provider; honest providers that disagree with the 0G model are never slashed (and why `CANARY_MODEL_SLASHES` is off) |
| `test/tasks.test.ts` | One labelled set per built-in task; a job per task plants its known answers, admits on them, and passes the passport |
| `test/quorum.test.ts` | 2-of-3 verifier slashes: refund and burn, HCS records, Arkiv check entities feeding ranking; non-confirming cosigners block a slash; disputes upheld (buyer gets the challenge too) or undecided (cancelled for the provider) |
| `test/vault-contract.test.ts` | `KineticBondVault` bytecode: verdict digest bound to vault and chain, distinct-quorum ordering, dispute window and burns, disputes and timeouts; HIP-1215 scheduled `executeSlash` and its fee; HIP-351 seeds (one per tag) |
| `test/hedera-anchor.test.ts` | Merkle anchor per job (Hedera batch-anchor-verify format) and proofs; PRNG spot checks picked from a seed drawn after the reveal; passport catches changed chunks or picks |
| `test/tiers.test.ts` | Assurance tiers: pricing, basic (signatures and formats only, a fifth of the fee), high (two agreeing providers per chunk), confidential (TeeML-attested 0G nodes only) |
| `test/zerog-canary-tee.test.ts` | Canary reference runs: `private` (TeeML-only) with a TEE signature recovered against the on-chain signer; noted fallback to `verified`, or none; forged signatures refused |
| `test/zerog-compute.test.ts` | Direct 0G Compute: per-chunk attestation (verified / invalid / unavailable, centralized relays named), used chat ids kept across restarts, 0G provider choice, rerouting when a 0G provider fails, slashing a provider that stops calling it or alters the 0G answer |
| `test/fingerprint.test.ts` | Model fingerprints: stable, distinguishing probes; consistent vs mismatch (names the look-alike model); `data/fingerprints.json` catches a swapped-in small model |
| `test/models.test.ts` | Safetensors malware checks (hidden bytes, overlaps, pickle, custom code, unsafe file names, on-disk reads); signed model cards and versions; royalty rounding and quote; quorum review signs only on matching answers |
| `test/model-hub.test.ts` | Model hub end to end: quorum-signed Model Passport stored on 0G Storage, weights on 0G Storage, HCS log, Arkiv listing; jobs only on serving providers; cheaters still slashed; creator paid exactly its royalty share; refuses pickle weights, unsigned cards, relisted versions, unserved-model requests before payment |
| `test/sdk.test.ts` | SDK: HBAR parsing, built-in tasks, a verified job by task name, kill switch |

---

## 16. Code map: every folder and file

```
KINETIC/
├─ contracts/KineticBondVault.sol    Bonds, timelocked withdraw, quorum slash, disputes, refund + burn
├─ src/
│  ├─ env.ts                         Imported first by entry points: loads a local .env (library code never does)
│  ├─ config.ts                      Env → NetworkConfig / Identity (testnet; devnet only under the test runner); facilitator list
│  ├─ networks.ts                    TESTNET preset: HCS topic, vault address, verifier URL
│  ├─ types.ts                       Shared domain types; HBAR/token amount formatting
│  ├─ live.ts                        Full scenario on real networks (cosigners, verifier, 5 providers, buyer, model hub); writes evidence file
│  ├─ core/
│  │  ├─ chunker.ts                  splitIntoChunks
│  │  ├─ canary.ts                   select / commit / reveal canaries
│  │  ├─ policy.ts                   CanaryWindow (slash threshold)
│  │  ├─ agreement.ts                Job agreement: build, check, hash, describe
│  │  ├─ quote.ts                    Firm quote: the most a job can cost, committed before work
│  │  ├─ tiers.ts                    Assurance tiers (basic, standard, high, confidential) and their rules
│  │  ├─ verdict.ts                  Slash verdicts and quorum signatures as the vault checks them
│  │  ├─ spot.ts                     Spot-check picks from a Hedera PRNG seed drawn after the reveal
│  │  ├─ merkle.ts                   One HCS Merkle-root anchor per job, and per-chunk proofs
│  │  └─ fingerprint.ts              Model fingerprints: does a provider run the model it declares (never slashes)
│  ├─ tasks/
│  │  ├─ prompt.ts                   Build prompts, parse model output
│  │  ├─ validate.ts                 Format check of results
│  │  └─ compare.ts                  Agreement score per task kind
│  ├─ integrations/
│  │  ├─ index.ts                    connect() / connectCosigner(): wires every client for a role (devnet adapters: tests only)
│  │  ├─ x402.ts                     PaymentGate (server, facilitator failover, replay guard), payFetch + signers (client)
│  │  ├─ hcs.ts                      Receipt types, HCS writer, mirror reader
│  │  ├─ mirror.ts                   creditedAmount (payment truth from ledger; HBAR, token path for old passports)
│  │  ├─ vault.ts / vault-deploy.ts  Bond vault client (quorum slash, disputes, HIP-1215 schedule, HIP-351 seeds) and deployer
│  │  ├─ arkiv.ts                    Arkiv store (SDK + batched queue, named schemas, devnet store), TTLs
│  │  ├─ storage.ts / storage-ref.ts DocumentStore: passports on 0G Storage by root, public indexer links
│  │  ├─ zerog.ts                    0G router client (reference, chat, tools, balance)
│  │  ├─ zerog-tee.ts                Our own check of a router run's TEE signature against the on-chain signer
│  │  ├─ zerog-compute.ts            0G Compute called directly: one 0G provider, TEE-signed chat ids, attestation
│  │  ├─ zg-storage.ts               0G Storage client for weights and passports (root hash checked on every download)
│  │  ├─ erc8004.ts                  ERC-8004 identity and reputation registries on 0G Chain
│  │  └─ identity.ts                 HCS-14 UAIDs
│  ├─ models/                        Model hub
│  │  ├─ card.ts                     Model card: signed by its creator, versioned, royalty capped at 30%
│  │  ├─ passport.ts                 Model Passport: checks, benchmark, fingerprint, verifier quorum signatures
│  │  ├─ safetensors.ts              Malware checks on weights (safetensors only, exact tiling, no code)
│  │  ├─ weights.ts                  Fetch weights from 0G Storage or a URL, checked against sha256
│  │  ├─ review.ts                   One verifier's own review of a model before it signs
│  │  ├─ runner.ts                   How a verifier runs a model (0G, or VERIFIER_MODEL_URL)
│  │  ├─ registry.ts                 `model` listings on Arkiv, trusted only from vault verifiers
│  │  └─ publish.ts                  Creator side: check, upload, sign, pay the listing fee, wait for review
│  ├─ provider/
│  │  ├─ node.ts                     Bond, x402 gate, /v1/chunks, Arkiv offer + heartbeat, served models
│  │  ├─ backend.ts                  backendFromEnv / backendForEnv (0g | 0g-compute | openai), DEFAULT_0G_WORKER_MODEL, behaviours, adversarialLabel()
│  │  ├─ options.ts                  providerOptionsFromEnv (PROVIDER_* settings)
│  │  ├─ models.ts                   Check a listed model's passport and weights before serving it (optional Ollama import)
│  │  └─ server.ts                   Run a provider as a process
│  ├─ verifier/
│  │  ├─ verifier.ts                 Canaries, known answers, admission, judging, slashing, spot checks, reputation
│  │  ├─ known.ts                    Labelled sets: plant known answers, split admission/planting halves
│  │  ├─ checks.ts                   Repeatable checks and the slash packet a cosigner re-checks
│  │  ├─ cosigner.ts                 Cosigning verifier: re-checks slashes, disputes and model reviews before signing
│  │  ├─ cosigner-server.ts          Run a cosigner as a process (`npm run cosigner`)
│  │  ├─ models.ts                   Model desk: reviews, quorum-signed Model Passports, listing renewal
│  │  ├─ arkiv-mirror.ts             Live copy of Arkiv entities from entity events, for the dashboard proxy and SSE
│  │  ├─ service.ts                  HTTP API + x402 fee gates + Arkiv mirror reads
│  │  └─ server.ts                   Run the verifier as a process
│  ├─ agent/
│  │  ├─ buyer.ts                    BuyerAgent: discover, rank, qualify, dispatch, reroute, report
│  │  ├─ ranking.ts                  Provider scores and strategies
│  │  ├─ passport.ts                 Compute Passport: build, sign, verify
│  │  ├─ passport-schema.ts          Compute Passport v2 schema (and its JSON Schema export)
│  │  ├─ assurance.ts                Per-chunk authenticity vs correctness claims, and their summary
│  │  ├─ service.ts                  Agent HTTP API (runs, models, publish, 0G key/balance, halt, resume)
│  │  ├─ report.ts                   Load job, print/save reports, job-rule CLI flags
│  │  └─ cli.ts                      Run the buyer as a CLI
│  ├─ cli/
│  │  ├─ kinetic.ts                  `npm run kinetic`: init, status, run, models, provider, tasks
│  │  └─ setup.ts                    The account/gas steps `init` and `status` are made of
│  ├─ sdk/index.ts                   `Kinetic` class and builtInTasks(): KINETIC from your own code
│  ├─ testnet/roles.ts               Role table (verifier, verifier-2/-3, buyer, creator, BluePeak, Riverstone, QuickCompute, EdgeRelay, BudgetGPU), state.json, per-role env files
│  └─ util/                          crypto (AES-GCM, HKDF, canonical JSON), wrap (chunk keys wrapped to a provider, ECIES), sign, http, log, state (files that survive restarts)
├─ scripts/                          setup-testnet, doctor, calibrate, verify-passport, passport-schema, keys, create-topic,
│                                    deploy-vault, bonds, zerog, register-hol, fingerprint, gold-check,
│                                    migrate-passports, make-dataset, smoke-hedera (see §13.2)
├─ docker/ollama-sandbox.compose.yml Provider + Ollama on a network with no route out, checked weights mounted read-only
├─ test/                             Vitest suites (see §15)
│  └─ support/                       Test harness only (§12): devnet.ts (emulator), evm.ts (in-process EVM), scenario.ts, heuristic.ts
├─ web/                              Vite + React app (see §11): landing page (pages/Landing.tsx), Models, and a full-screen
│                                    Console (console.tsx) holding runs, jobs, GPUs, publishing, creators and docs
├─ data/                             Tasks, sample tickets, labelled sets, model cards, fingerprints (§14)
├─ docs/                             Guides (this one, USE_KINETIC, RUN_A_PROVIDER, MODEL_HUB, …) and compute-passport.schema.json
├─ arkiv/                            Arkiv write-ups: schema, why, how, friction, reach
├─ DESIGN.md                         Visual direction for web/
├─ out/                              Generated job reports and live evidence (git-ignored)
└─ .kinetic/                         Generated keys and env files: testnet/ (per role, state/), buyer.env / provider.env, models/ (checked weights) (git-ignored, SECRET)
```

---

## 17. Ports and HTTP endpoints

| Port | Process |
|---|---|
| 4400 | Test harness devnet (only while tests run) |
| 4500 | Verifier (`VERIFIER_PORT`) |
| 4510, 4520 | Cosigning verifiers `verifier-2`, `verifier-3` (`COSIGNER_PORT`, default 4510) |
| 4600 | Buyer agent service (`npm run live -- --serve`) |
| 5101–5105 | Provider nodes (`PROVIDER_PORT`, default 5101) |
| 5173 | Dashboard (Vite, strict: 0G's sign-in only works on localhost 3000, 3001 or 5173) |
| 11434 | Ollama (optional, `PROVIDER_BACKEND=openai`, `VERIFIER_MODEL_URL`) |

**Provider** (`src/provider/node.ts`): `GET /health` (name, pay-to, GPU, backend, 0G provider, served models, sandbox, adversarial label), `POST /v1/chunks` (x402; a request for a model it doesn't serve is refused before payment).

**Verifier** (`src/verifier/service.ts`):
- Reads: `GET /status`, `GET /erc8004/reputation` (cached), `GET /arkiv/stats`, `GET /arkiv/events` (Server-Sent Events), `GET /arkiv/:kind` (live-mirror dashboard reads; kinds `offer`, `claim`, `job`, `chunk`, `reputation`, `check`, `model`), `GET /jobs/:id/canaries`.
- Jobs: `POST /jobs` (signed + x402 fee), `POST /qualify`, `POST /jobs/:id/results`, `POST /jobs/:id/finalize`, `POST /jobs/:id/attest` (co-sign the passport), `POST /jobs/:id/passport` (store the signed passport on 0G Storage; returns its root and URL) (all signed), `POST /jobs/:id/royalty` (signed + x402 to the model's creator), `GET /passports/:root` (a stored passport, checked against its root).
- Model hub: `POST /models` (signed + x402 listing fee; review runs in the background, 202), `GET /models/reviews/:key`, `GET /models`, `GET /models/:key/passport` (from 0G Storage).

**Cosigner** (`src/verifier/cosigner.ts`, run by `cosigner-server.ts`): `GET /status`, `POST /cosign` (re-check and sign a slash), `POST /review` (decide a disputed slash), `POST /models/attest` (re-review a model and sign its passport). Every POST must come from a vault verifier.

**Agent service** (`src/agent/service.ts`): `GET /presets`, `GET /runs`, `POST /runs` (start a job), `GET /models`, `GET /models/:key/samples`, `GET /publish/templates`, `POST /publish`, `GET /publish/:key`, `GET|POST|DELETE /zerog-key`, `GET|POST /zerog-balance`, `POST /halt`, `POST /resume`.

---

## 18. Live testnet evidence

Public, already-deployed resources from the team's runs:

| Resource | ID |
|---|---|
| HCS audit topic | `0.0.11212792` |
| Bond vault (Hedera EVM), current (version 4): quorum, disputes, PRNG seeds, self-executing slashes; source verified on Sourcify | `0x585054f20af2c3023156c10a3ee4bdeed90bb48a` |
| Bond vaults, version 3 — retired | `0x9142b233279c241a7478f58fe06e543552ad26d3` (2026-11-05), `0x4dcb923afeb0664e9ebb013fd2236f78f1d63084` (2026-11-03) |
| Bond vault, 2026-10-31 quorum runs | `0x11d76cec886b06d5f8e7f4e7d9a5fa2c9808b294` |
| Bond vault, first (single verifier) — historical | `0x019631c2acfeb747dfc6b9ca388cefc83833bee6` |
| KUSD token (HTS) — historical only, no longer used | `0.0.11220110` |
| Verifier / buyer EVM addresses (Arkiv writers) | `0xa19c…adc8` / `0x8ed8…73a6` |

**Current deployment (2026-11-05):** `job-mw3qzkrd-585265` on vault version 4 and Arkiv Rabdi: QuickCompute slashed and the slash executed by the vault's own scheduled call (refund 0.003 ℏ, 0.997 ℏ burned), BudgetGPU rejected, EdgeRelay offline and rerouted, 4 of 4 canaries TeeML with verified TEE signatures, and a PRNG spot check that agreed. Every link and the passport are in `evidence/README.md`; `passport:verify` passes every check.

**Earlier (2026-11-03):** `job-mw132jrv-a8b923`, a model job on `kinetic/invoice-extractor` (extract, 6% royalty): 6 items in 3 chunks, standard tier, on vault `0x4dcb…3084` and Arkiv Rabdi. All 3 planted known answers and the 1 canary passed. BudgetGPU was rejected at admission, and BluePeak, Riverstone and EdgeRelay did the work. After the reveal, a vault PRNG seed ([`0x7040…4c48`](https://hashscan.io/testnet/transaction/0x70402d5346df39a22dbff28e900e334faba5733e697fe9f40ea49cfe27d4bc48)) picked chunk 1 for a spot check, which agreed 100% with `glm-5.3`. The job's Merkle anchor is HCS message #1124 ([tx](https://hashscan.io/testnet/transaction/0.0.11212783-1793734404-926747346)). The creator's royalty was 0.00018 ℏ on 0.003 ℏ of accepted chunk payments ([tx](https://hashscan.io/testnet/transaction/0.0.9185802-1793734402-936202910)). Passport v2 verification `passed`. Source: the job's Compute Passport, saved for the demo video at `demo-video/look/cp.json`.

**The jobs below are from before the changes in this guide.** They used the old provider names (`cheapo-3060`, `shoddy-1060`, …), the `qwen3.7-flash` referee, payments in KUSD for some jobs, and providers on Ollama or on the old silent 0G fallback. They remain valid historical evidence (their passports can still be checked with `passport:verify`), but they do not show the current setup.

**Before the quorum vault:** `job-mvuj3yuh-f230e4`: 60 tickets / 20 chunks, every provider on 0G Compute (`0gm-1.0-35b-a3b`), `glm-5.3` referee, HBAR. `cheapo` slashed and the buyer refunded 0.0042 ℏ (vault tx `0x577d…bd11`), `shoddy` rejected at 0%, `flicker` went down and its kept 0.0008 ℏ payment was reported, and honest `nimbus` was rejected because its 0G call returned HTTP 500 during admission (a real failure). Net 0.0228 ℏ; the passport passes every `passport:verify` check. Details in the README and `out/live-job-mvuj3yuh-f230e4.md`.

Notable historical jobs (details and HashScan links in `README.md` and `out/`):
- `job-mvsji5xu-9915f8` — 60 tickets / 20 chunks, paid in HBAR; cheapo-3060 slashed and refunded 0.0036 ℏ; shoddy-1060 rejected at 17%.
- `job-mvtbwqvv-fb6b43` — paid in KUSD; refunded 0.0054 ℏ.
- `job-mvterakx-44ac85` — every provider on Ollama `qwen2.5:3b-instruct` on a CPU-only laptop; canaries agreed 100% with 0G (`qwen3.7-flash` then).

---

## 19. Known limits and housekeeping

**Design limits (the README's "Known limits" has the full list):**
- **One operator holds every verifier key.** A slash needs 2 of 3 verifier signatures, and each cosigner re-checks the evidence with its own 0G runs, but on testnet all three keys are ours. The verifier set is fixed when the vault is deployed.
- **Disputes are decided by the same verifiers** (all three by default); there is no outside arbitrator, and a provider can't submit its own counter-evidence.
- **Short dispute window:** `VAULT_DISPUTE_WINDOW` defaults to 60 s for testnet demos; real deployments want hours.
- Each provider handles one chunk at a time.
- **Known answers** cover the ten labelled tasks only, one item per chunk, from small reused sets (24–36 items). A production verifier needs large, rotating sets.
- **Other signals are statistical:** admission probes, model canaries, spot checks and the model check sample behaviour; none proves which model ran. A canary compares the provider with a *different* 0G model, so it only fails the chunk. The model check (§8.15) catches a swap to a small model but can't tell similar large models apart.
- **High assurance assumes independent providers;** KINETIC keeps the two copies on different providers but can't see who operates them.
- **Confidential means attested execution, not hidden data:** the KINETIC provider decrypts each chunk before sending it to 0G. No 0G route returns the router's own `tee_verified` verdict; the verifier checks canary TEE signatures itself (§8.9), but because requests are sealed end to end it can't bind a signature to the plaintext answer.
- **No model hashes for 0G-served models:** `authenticity.model.hash` is `null`, since neither 0G nor OpenAI-compatible servers publish one. Models with published weights are pinned by sha256 in their card.
- **No delisting yet:** a listed model's status is only `reviewing`, `listed` or `refused`. A model that misbehaves on live jobs isn't taken off the hub.
- **The provider sandbox is declared, not enforced:** `PROVIDER_SANDBOX` is a label in the provider's own offer. `docker/ollama-sandbox.compose.yml` is provided, but nothing checks that a provider uses it.
- **Revocation is for future chunks only;** a chunk key or sealed chunk a provider has received can't be taken back.
- **One operator runs every provider.** The adversarial test providers (QuickCompute, EdgeRelay, BudgetGPU) are separate accounts and nodes, labelled as such in their offers, reputation, reports and passports, but run by the same team as the honest ones. No outside provider has joined yet.
- **One x402 payment per recipient:** the verifier fee and the royalty are separate payments from each chunk's (§8.1).
- **0G sign-in needs 0G's Privy app id** (the management-key path works without it).
- Every 0G chat model tested scored 100% on the gold tickets, so the failures the checks catch come from behaviour (skipping the model, going offline), not from a weaker model.
- **Testnets only.** Nothing has run with real funds, and Arkiv has no mainnet yet.

**Housekeeping worth doing:**
- **Secrets on disk:** `.kinetic/testnet/state.json` stores every role's private key in plain text, and `.env` holds the operator key and API keys. Both are git-ignored, but never share the folder as a zip or copy them anywhere public. They are testnet keys, but the 0G and Arkiv API keys are real credentials.
- `@stripe/stripe-js` in `web/package.json` is unused.
- `arkiv/reach.md` and `arkiv/friction.md` have `TODO(team)` placeholders; the README notes the demo video, live demo link and team names are still to add.

---

## 20. Glossary

| Term | Meaning |
|---|---|
| **Chunk** | A small fixed-size slice of a job (e.g. 3 tickets), paid and verified independently |
| **Canary** | A real chunk secretly re-run on 0G's reference model to check a provider; hidden by commit/reveal |
| **Adversarial test provider** | A real provider node on the real testnets that really cheats (`lazy`, `degrade-after:N`, `offline-after:N`, `flaky`) and says how in an `adversarial` attribute of its offer; buyers don't route on it, so the checks must catch it |
| **Admission probe / qualification** | Paid known-answer chunk sent before a provider gets work |
| **Gold set** | Tickets with true labels used for admission probes |
| **Agreement** | Share of items where provider output matches the reference (0–1) |
| **Slash** | Vault call that refunds the buyer from a provider's bond and marks it slashed |
| **Quarantine** | Job-scoped: a provider with a failed canary loses its unverified chunks |
| **Reroute** | Putting a chunk back on the queue for a different provider |
| **Reserve** | An admitted, ranked provider kept waiting; it steps in when a working provider drops out |
| **Compute Passport** | Signed public record of a job's results, checks, payments and limits; verifiable by anyone |
| **Job agreement** | The rules a buyer sets before work (check rate, pass mark, admission examples, budget, deadline), committed on HCS by hash |
| **x402** | Protocol using HTTP 402 to pay for API calls per request |
| **Facilitator** | Service that verifies and settles x402 payments on-chain |
| **HCS** | Hedera Consensus Service: ordered, timestamped message log |
| **HTS** | Hedera Token Service; KINETIC no longer pays in HTS tokens |
| **KUSD** | Historical HTS test token (`0.0.11220110`) some earlier jobs paid in; payments are now HBAR only |
| **HCS-14 / UAID** | Hashgraph Online standard for Universal Agent IDs |
| **Mirror node** | Public REST API for reading Hedera history |
| **Arkiv** | Chain for owned, expiring, queryable data entities |
| **Strategy** | How the buyer weights price, track record and speed: cheapest, balanced or fastest |
| **0G Storage** | 0G's decentralised file storage; files are addressed by the Merkle root of their bytes |
| **0G Private Computer** | 0G's TEE-backed, OpenAI-compatible inference router paid with iAI credits |
| **TEE / TeeTLS / TeeML** | Trusted Execution Environment; 0G's verifiability modes. TeeTLS: a TLS-attested proxy to an outside provider (e.g. `qwen3.7-flash`, served by Alibaba Cloud). TeeML: the model runs on a 0G Compute node (e.g. `glm-5.3`, `0gm-1.0-35b-a3b`) |
| **E2EE marker** | The `X-0G-E2EE: sealed` response header, recorded as `e2ee` on each reference run |
| **tinybar** | 10⁻⁸ HBAR |
| **Devnet** | The automated tests' harness: an emulator of all external networks in `test/support/`, refused outside the test runner |
