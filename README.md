# KINETIC

**The verifiable AI hub: host open models, run them on community GPUs, and get every result checked. If a provider cheats, you're refunded automatically.**

KINETIC lets AI agents run batch AI jobs (classification, extraction, tagging) on community GPUs without trusting the provider, and lets model creators list their models and earn a royalty on every job that runs them ([model hub](#model-hub)).

- **Split:** every job is cut into independent chunks, and each chunk is paid separately over x402.
- **Verify:** hidden canary chunks are compared against 0G verified runs to measure each provider's quality.
- **Enforce:** if a provider fails the threshold (e.g. 3 of 10 canaries), its bond is slashed and the buyer is refunded.
- **Recover:** chunks from failed or offline providers re-route automatically.

You pay only for chunks that complete and pass verification, and every result and payment leaves an on-chain record.

- **Model hub:** creators publish a signed model card; a quorum of verifiers runs malware checks on the weights, benchmarks the model and fingerprints it, then signs its **Model Passport**. Buyers click **Run via KINETIC**, only providers that checked the model serve it, and the creator is paid a royalty on the accepted chunks, never on refunded ones.

**Status: complete.** Every part described here is built and runs on the live testnets: the model hub, paid jobs over x402, hidden checks on 0G, quorum slashing and refunds, rerouting, Sign in with 0G, the Compute and Model Passports, and the dashboard. See [Live testnet evidence](#live-testnet-evidence) for the records and [Sponsor requirements](#sponsor-requirements) for where each prize requirement is met.

### How it's made

- **Hedera:** x402 per-chunk payments in HBAR, x402 model listing fees and creator royalties, provider bonds, slashing and exact refunds; HCS audit receipts (including every Model Passport and royalty); HCS-14 agent identities.
- **0G:** providers do their work on 0G Compute (`0gm-1.0-35b-a3b`, TeeML); the verifier checks them against a different 0G model (`glm-5.3`, TeeML). 0G Storage holds model weights, Model Passports and Compute Passports (public). Users sign in with their 0G account and their credits can pay for their own agent.
- **Arkiv:** the model registry (listings renewed by the verifier), expiring provider offers (with the models each serves), chunk claims, job state and reputation, all read by the live dashboard.

---

## Everything is real

KINETIC runs only on the real networks: Hedera testnet, Arkiv (the Rabdi testnet) and 0G. The only exception is an opt-in, clearly labelled [synthetic replay](#synthetic-replay-fallback) in the dashboard, kept as a fallback for when the networks can't be reached (the automated tests use a local emulator; see [Tests](#tests)). Five provider nodes bond real HBAR and publish real offers, and every one does its work on **0G Compute**:

| Provider | Price / chunk | Runs | Behaviour | What happens |
|---|---|---|---|---|
| `BluePeak` | 0.001 ℏ | 0G `0gm-1.0-35b-a3b` | honest | keeps its work, passes canaries |
| `Riverstone` | 0.0012 ℏ | 0G `0gm-1.0-35b-a3b` | honest | keeps its work, passes canaries |
| `QuickCompute` | 0.0006 ℏ | 0G `0gm-1.0-35b-a3b` | **adversarial:** stops calling its model after 3 chunks | passes admission, fails known answers on job work, **slashed**, buyer **refunded**, its chunks **rerouted** |
| `EdgeRelay` | 0.0008 ℏ | 0G `0gm-1.0-35b-a3b` | **adversarial:** goes down while chunk 5 is paid, keeping that payment | marked offline, its chunk **rerouted**, the payment it kept is found on the ledger and reported |
| `BudgetGPU` | 0.0004 ℏ | nothing | **adversarial:** never calls a model | **rejected at admission** on known answers, never paid for job work |

Runs before 2026-11-01, including the evidence below, called them `atlas`, `nimbus`, `cheapo`, `flicker` and `shoddy`, and set the two thresholds at 1 and 3 chunks. A provider can't tell the verifier's admission probes (3 chunks on a fresh start) from job work, so the thresholds count them: QuickCompute cheats from its first job chunk, and EdgeRelay drops on its second.

The three adversarial providers are real nodes that really cheat on the real networks, so the checks have something to catch: their payments, slashes and refunds are real transactions. Each one says so in its Arkiv offer (`adversarial: "never calls its model"`, …), and the dashboard and Compute Passport show the label. Buyers don't route on it: `QuickCompute` is admitted and paid like anyone else until a canary catches it. Why not weaker real models instead? Every 0G chat model we measured scored 100% on the labelled tickets, so none fails on its own.

```bash
npm install
npm run live -- --serve      # verifier, five providers and the buyer agent on the testnets
npm run web                  # dashboard at http://localhost:5173
```

First-time setup (accounts, HCS topic, bond vault, Arkiv gas) is in [Running on testnets](#running-on-testnets).

**Joining the network yourself:** `npm run kinetic -- init buyer` or `init provider` sets up your own key, Hedera account and Arkiv gas in a few minutes. Buyers can then run jobs from the command line or from their own code ([docs/USE_KINETIC.md](docs/USE_KINETIC.md)), and providers start their node with `npm run kinetic -- provider` ([docs/RUN_A_PROVIDER.md](docs/RUN_A_PROVIDER.md)).

### The dashboard

In live mode, every number on it comes from a public source: Arkiv (offers, claims, jobs, chunks, reputation), HCS through the Hedera mirror node (payments, canaries, slashes), and the verifier's canary evidence. Nothing is animated from a script. (The synthetic replay below is the one exception, and it says so on every page.)

The website has two parts, picked from the two toggles in its header:

- **Landing page** (`#/`). What KINETIC is and how a job is checked, with a model search. It shows no live figures, so it loads before the network answers.
- **Models** (`#/models`). The model hub: one card per listed model with its benchmark score, GPUs serving it, jobs run, runtime, where its weights live and its royalty. Each model page has its Model Passport and a **Try it** run.
- **Console** (`#/console`). A full-screen workspace in the style of an IDE: an activity bar, an explorer of jobs, GPUs, models and creators, tabs, an Activity / Problems panel (live HCS receipts, failed checks and slashes), a status bar, and a command palette (`Ctrl`/`⌘` `K`). Everything you operate opens here:
  - **Overview.** Live totals, recent jobs and live activity.
  - **Run.** Pick a model or task, ticket count, chunk size, max price per chunk, job budget, assurance tier and provider strategy, with a firm quote from the live offers and a **Stop all paid work** kill switch.
  - **Jobs.** Each job opens as numbered stages: admission probes, the chunk grid, x402 payments per provider, canaries vs 0G (agreement, diff, 0G request id), slashes, reroutes, settlement and evidence (commitment, reveal, spot checks, Merkle anchor, Compute Passport). Every transaction links to HashScan.
  - **GPUs.** One card per provider, live ones first: live / offline / rejected / slashed, what it runs (e.g. `0G Compute (TeeML) · 0g:0gm-1.0-35b-a3b`), a **test** badge for adversarial test providers, price, bond, latency, earnings and the checks it passed. **Details** adds admission, model check, reputation, identity and sandbox.
  - **Publish** and **Creators.** Publish a model (card, weights, malware checks, verifier review), and a creator's dashboard of their models and royalty payments.
  - **Earn.** How to publish a model or rent out a GPU.
  - **Audit trail.** Every HCS receipt, filterable by type.
  - **Docs.** Getting started and the verifier API.

### Synthetic replay (fallback)

If the testnets, 0G or the local services are down, the dashboard can run on synthetic data instead: open it with `?replay` (`http://localhost:5173/?replay`), or click **Use the synthetic replay instead** on the "Waiting for the verifier" banner. `?replay=0` (or the **synthetic replay · exit** badge) goes back to live. `VITE_REPLAY=1 npm run web` forces it on.

- It runs entirely in the browser ([web/src/replay.ts](web/src/replay.ts)) and makes no network calls. Every page, the Run form and the kill switch work.
- Starting a job plays the same story as the real runs in [out/](out/): BudgetGPU is rejected at admission, QuickCompute fails three hidden checks and is slashed by 2 of 3 verifiers with the buyer refunded, EdgeRelay goes down holding a payment, and the affected chunks are rerouted. Later jobs run cleanly on BluePeak and Riverstone. `?replay&speed=2` plays it twice as fast.
- Provider names, prices, addresses and the policy match the testnet deployment. Every transaction id, hash, 0G request id and passport reference is invented, so nothing links to HashScan or 0G Storage.
- A **synthetic replay** badge stays in the top bar, and the status bar and overview say so.

---

## Model hub

Full guide: [docs/MODEL_HUB.md](docs/MODEL_HUB.md).

```bash
npm run kinetic -- models publish --card data/models/ticket-classifier.card.json   # list a model (pays the x402 listing fee)
npm run kinetic -- models                                                          # browse the registry
npm run kinetic -- models show kinetic/ticket-classifier                           # its Model Passport, every check on it
npm run kinetic -- run --model kinetic/ticket-classifier --items tickets.jsonl     # run it; pays its creator a royalty
PROVIDER_MODELS=kinetic/ticket-classifier npm run provider                          # serve it, after checking it
```

- **Publish:** a creator-signed card (id, version, task, runtime, weights hashes, licence, royalty of 0–30%). Weights must be safetensors and go to 0G Storage (multi-GB files, addressed by Merkle root) or are fetched from a source URL; the malware checks run on the creator's machine first. Weights stream through disk at every step, so a 3 GB model needs disk, not memory.
- **ERC-8004 on 0G Chain:** the verifier and every GPU register themselves as Trustless Agents (Identity Registry on Galileo, agent card on-chain). After each job the verifier gives each GPU feedback in the Reputation Registry: the share of hidden checks it passed, with the evidence attached, plus a record of any executed slash. The GPUs page reads the averages back from 0G.
- **Listed on testnet:** 11 models with quorum-signed passports: a ticket classifier, review sentiment, spam, intent, news topic, language and animal classifiers, invoice and ticket-field extractors and a ticket tagger (all on 0G Compute), plus SmolLM2-135M weights on 0G Storage. The cards are in [data/models/](data/models/); `npm run live` lists any that aren't yet.
- **Review:** the verifier and each of the vault's other verifiers, on their own: malware checks on the exact bytes (no pickle or code, no custom model code, headers that exactly tile each file), a benchmark on labelled examples the creator never saw (70% to list), and a behavioural fingerprint. The Model Passport needs as many signatures as a slash does. The listing verifier stores it on 0G Storage, its digest goes to HCS, and the listing to Arkiv.
- **Serve:** providers check the passport, every weights file's sha256 and the malware checks again before they offer a model; [docker/ollama-sandbox.compose.yml](docker/ollama-sandbox.compose.yml) runs the model on a network with no route out.
- **Run:** a model job uses only providers serving the model, admits them with probes and the model's fingerprint, commits the model and its royalty in the agreement on HCS, and requires every chunk to be signed for the model. Afterwards the buyer pays the creator over x402: the agreed share of the accepted chunks, computed by the verifier, never including refunded or rerouted work. The verifier won't co-sign the Compute Passport until it's paid, and `passport:verify` checks the royalty on the ledger.

## How a job runs

```
 Buyer agent                       Providers (community GPUs)          Verifier agent (0G credits)
 ───────────                       ──────────────────────────          ───────────────────────────
 1 split into chunks
   encrypt each (own key)
   job + chunk entities ────► Arkiv
 2 register job + sealed chunks + x402 fee ──────────────────────────► pick hidden canaries
                                                                        commit hash ──► HCS
                                                                        0G verified runs on canaries
 3 discover offers ◄──────── Arkiv: offer entities (expire unless renewed)
   check bonds ◄──────────── Hedera: KineticBondVault
 4 per chunk:
   claim (2 min lease) ─────► Arkiv
   POST /v1/chunks (data) ──► 402 quote
   x402 payment ────────────► verify ─► run on GPU ─► settle (HBAR)
   signed result ◄──────────
 5 submit result + payment ──────────────────────────────────────────► check signature
                                                                        check payment on mirror node
                                                                        receipt ──► HCS
                                                                        canary? compare with 0G
                                                                        reputation ──► Arkiv
                                                                        3/10 failed? cosigners re-check,
                                                                          2 of 3 sign a slash ──► Vault
                                                                          (dispute window, then refund + burn)
   ◄──────────────────────────────────────────────────────── verdict
   failed canary / slashed provider / offline: requeue chunk elsewhere
 6 finalize ─────────────────────────────────────────────────────────► reveal canary set ──► HCS
   Compute Passport ────────────────────────────────────────────────────► co-sign if it matches
   signed passport ────────────────────────────────────────────────────► store on 0G Storage (root on the job entity)
```

**Evaluate, monitor, reroute, enforce.** KINETIC acts on benchmark harnesses to test inference vendors and publish the scores:

| | What KINETIC does | Signal | Code |
|---|---|---|---|
| **Evaluate before work** | The verifier pays each discovered provider for one probe chunk of known-answer tickets (it looks like any other chunk). Only providers that answer in the right format and match enough known answers are admitted to the job. | Ground truth labels | `Verifier.qualify` in [src/verifier/verifier.ts](src/verifier/verifier.ts) |
| **Monitor during work** | Every result is format-checked (each item answered once, only allowed values). Every chunk carries a planted known answer, scored against the truth. Hidden canaries are compared with 0G verified runs. Latency is recorded per provider. | Schema check, ground truth, 0G model comparison, timing | [src/tasks/validate.ts](src/tasks/validate.ts), [src/verifier/verifier.ts](src/verifier/verifier.ts) |
| **Reroute** | Offline providers, failed canaries, malformed results, slashed providers, and unverified work from quarantined providers all go back on the queue for others. | — | [src/agent/buyer.ts](src/agent/buyer.ts) |
| **Enforce through payment** | Settle only on success, slash the bond and refund the buyer at the threshold, quarantine a provider for the rest of the job after any failed canary. | — | [contracts/KineticBondVault.sol](contracts/KineticBondVault.sol) |

The signals are deliberately different: known answers (at admission and planted in every chunk) catch a provider that is wrong, and are what slashing rests on; the 0G comparison catches drift from a verified model on the buyer's real data, but only fails the chunk ([why](#checks-ground-truth-first-model-agreement-second)); format checks catch broken output on every chunk. All of them are sampled or statistical, not proofs of which model ran, and the dashboard says which is which.

**Why canaries stay hidden.** Canaries are ordinary chunks of the buyer's own job, picked at random by the verifier. Every chunk request looks the same, so a provider can't tell which ones are checked. The verifier posts a hash of the canary set to HCS before any chunk runs and reveals it at the end ([src/core/canary.ts](src/core/canary.ts)). Anyone can then check it didn't choose canaries after seeing results.

**Spot checks after the job, and one Merkle anchor.** Canaries can't come from public randomness, because they must stay secret until the job ends. So after the canary reveal is on HCS, when every result is already signed and receipted, the verifier draws one seed per job from Hedera's PRNG through the vault (HIP-351, `drawSeed`). That seed picks `SPOT_CHECKS` extra chunks (default 1) to re-run on 0G. Nobody could know the picks while the work was done, the vault allows one draw per job, and anyone can recompute the picks from the seed ([src/core/spot.ts](src/core/spot.ts)). The verifier then posts one `hcs.merkleRootAnchor` message per job: a SHA-256 Merkle root over every finished chunk's record, in the format of Hedera's batch-anchor tutorial. Each chunk in the Compute Passport carries its proof under that root ([src/core/merkle.ts](src/core/merkle.ts)). A spot check that disagrees is recorded in the passport; it doesn't slash, since the job is closed by then.

**Why you only pay for good work.**
- **Settle on success:** the provider settles the x402 payment only after the chunk succeeds, so a crash or error is never charged ([src/integrations/x402.ts](src/integrations/x402.ts)).
- **Refund on slash:** once a slash executes, the vault refunds the buyer everything it paid that provider for the job, from the provider's bond, and burns the rest of the bond. All of that provider's chunks are redone elsewhere as soon as the slash is proposed ([src/verifier/verifier.ts](src/verifier/verifier.ts), [src/agent/buyer.ts](src/agent/buyer.ts)).
- **Refunds are always covered:** the buyer never lets its spend at one provider in a job exceed that provider's bond.
- **Lost responses are reconciled:** if a provider settles a payment and then dies before answering, the buyer knows the payment's transaction id (it signed it), checks the ledger, and reports it as paid but undelivered instead of losing track of it.

**Why a buyer can't fake a refund.**
- **Signed results:** providers sign every result, and the verifier rejects results whose signature doesn't match the provider.
- **Mirror-checked payments:** the verifier sizes refunds from the HBAR transfers the mirror node shows, not from what the buyer claims.
- **No single key can slash:** a slash needs signatures from a quorum of the vault's verifiers (2 of 3 on testnet), once per provider per job. See [Slashing](#slashing-takes-a-quorum-and-can-be-disputed).

### Slashing takes a quorum, and can be disputed

A provider that fails `CANARY_FAIL_LIMIT` of its last `CANARY_WINDOW` checks isn't slashed on one verifier's word.

1. **Signed verdict.** The verifier signs a verdict that names the job, the chunk and the result hash that tipped the provider over the limit, plus a hash of every failed check behind it (the HCS receipts and each failing result). The vault checks the signatures over exactly those fields, bound to its own address and chain id ([src/core/verdict.ts](src/core/verdict.ts), [contracts/KineticBondVault.sol](contracts/KineticBondVault.sol)).
2. **Independent re-check.** The verifier sends the evidence to the vault's other verifiers. Each one, before it co-signs, checks the canary set against the commitment on HCS, re-runs every failed canary on 0G with its own credits, re-validates malformed results and 0G execution records, checks each result was signed by the provider, and caps the refund at what the mirror node shows the provider was paid. It signs only if at least the failure limit holds up ([src/verifier/cosigner.ts](src/verifier/cosigner.ts)). Without a quorum there is no slash: a `slash-refused` receipt goes on HCS and the buyer quarantines the provider for the job instead.
3. **Dispute window.** A proposed slash freezes the provider's bond but pays nothing yet. For `VAULT_DISPUTE_WINDOW` seconds the provider can dispute it by posting a challenge bond.
4. **Adjudication.** A disputed slash is re-checked by every verifier, and a larger quorum (`VAULT_DISPUTE_THRESHOLD`, all three by default) decides it: upheld, the buyer gets the refund and the challenge bond; overturned, the provider keeps its bond and gets the challenge back. Undecided at `VAULT_RESOLVE_TIMEOUT`, it is cancelled in the provider's favour.
5. **Settlement.** After the window the slash executes: the buyer is refunded, the provider is marked slashed for good, and the rest of its bond is burned once no other slash against it is open. On Hedera the vault settles it itself: proposing a slash pays the vault to book a scheduled `executeSlash` (Schedule Service, HIP-1215) for `SCHEDULE_DELAY` (10 s) after the window closes. The delay is there because Hedera's `block.timestamp` is the start of a ~2 s block, so a call booked for the closing second can still read as early and do nothing. This first ran live on 2026-11-05 ([evidence](evidence/README.md#2-dishonest-providers-get-penalized)). It is best-effort: `executeSlash` stays open to anyone, the verifiers' settle loop runs it if the schedule doesn't, and a slash settles only once.

Every step is an HCS receipt (`slash`, `slash-refused`, `dispute`, `settle`), and the Compute Passport records each slash's id, outcome and signers, checked against the vault by `npm run passport:verify`.

### Job agreement

Before any chunk runs, the buyer sets the rules for its job ([src/core/agreement.ts](src/core/agreement.ts)):

| Rule | Flag (`live`, `agent`) | Dashboard | Default |
|---|---|---|---|
| Share of chunks checked against 0G | `--check-rate 0.5` | Checked chunks % | the network's `CANARY_RATE` |
| Pass mark for a checked chunk | `--pass-mark 0.9` | Pass mark % | the network's `CANARY_MIN_AGREEMENT` |
| Admit providers on your own labelled examples | `--gold my-examples.jsonl --min-accuracy 0.9` | — | the verifier's examples |
| Deadline (no new paid work after it) | `--deadline 600` (seconds) | Deadline in minutes | none |

- **Locked in before work:** the verifier checks the rules when the job registers and puts their hash in the HCS `job` receipt next to the canary commitment, so nobody can change what counts as acceptable after seeing results. Your examples stay private: only their hash and count are published.
- **Never below the network's rules**, and fair to providers: your pass mark decides what *you* accept (a chunk below it is redone elsewhere), while slashing still follows the network's threshold. Checking more chunks than the network's rate raises the verifier's fee in proportion, because each check is a paid 0G run.
- **The outcome is reported:** the job report and the Compute Passport say whether the agreement was met (every chunk done within the budget and the deadline) and, if not, why. `passport:verify` checks the rules against HCS, the agreed check rate, and that every verified chunk met the pass mark.

### Checks: ground truth first, model agreement second

Disagreeing with another model isn't proof an answer is wrong: two good models can read an ambiguous ticket differently. So slashing rests on ground truth, and comparing with 0G only decides whether a chunk is accepted.

| Task | How it's checked | Can it slash? |
|---|---|---|
| Any task the verifier has labelled examples for: ten today (below) | **Known answers:** at registration the verifier plants one of its labelled examples in **every** chunk, at a random position under an id that looks like the buyer's own, and re-encrypts the chunk under its own key. It commits on HCS to where they went and reveals it at the end. A miss is scored exactly (same label, same tag set) | yes |
| Any task | **Format and execution checks:** every item answered once with allowed values; a claimed 0G run that its record or TEE signature contradicts | yes |
| Any task | **Hidden model canaries:** sampled chunks compared with a 0G verified run on a different model, on the buyer's own items only | no: the chunk fails and the provider is quarantined for the job. `CANARY_MODEL_SLASHES=true` restores the old rule |
| Tasks without labelled examples | format, execution and model canaries only; the passport says no known answers were planted | format and execution only |

**Ten tasks with known answers**, each a folder in [data/tasks/](data/tasks/) (`task.json`, labelled `gold.jsonl`, job `items.jsonl`) plus the original ticket set; the verifier checks a job against the set whose task (kind, labels, fields) it is, and admits providers per task:

| Task | Kind | Labels or fields |
|---|---|---|
| `classify-tickets` | classify | billing, bug, account, shipping, feature_request, other |
| `sentiment` | classify | positive, negative, neutral |
| `language` | classify | english, spanish, french, german, italian |
| `news-topic` | classify | sports, politics, technology, business, health |
| `spam` | classify | spam, not_spam |
| `intent` | classify | book_flight, cancel_order, check_balance, reset_password, track_package |
| `animal-class` | classify | mammal, bird, fish, reptile, insect |
| `ticket-tags` | tag | refund, login, mobile, shipping (any subset) |
| `ticket-fields` | extract | email, order_id |
| `invoice-fields` | extract | invoice_number, due_date |

**Calibrated before they can slash.** `npm run gold:check` runs every labelled item through the providers' 0G model and the verifier's reference model and keeps only the items both answer exactly as labelled (`--write` drops the rest), because a planted answer a good model gets "wrong" would slash an honest provider. All 252 items passed both `0gm-1.0-35b-a3b` and `glm-5.3` on 2026-10-31. Add a task by adding a folder and running it.

- **Hidden:** every chunk has a planted item, so chunk size gives nothing away.
- **Kept apart from admission:** the labelled set is split in two. Admission probes (whole chunks of known answers) use one half, planting the other, so a provider that logged its probes can't spot planted items.
- **Out of the results:** the buyer drops planted items before handing results back. The passport keeps the provider's answers to them, by position, so anyone can still recompute the hash the provider signed. It never contains a planted item's text or its true label.
- **Checked by every cosigner:** a cosigner confirms a missed known answer against its own copy of the labelled set, with no 0G cost, before it signs a slash.

The code is in [src/verifier/known.ts](src/verifier/known.ts). The test that shows why this matters: with the 0G reference model disagreeing with every honest answer, honest providers are never slashed and the lazy one still is; under the old rule, honest providers get slashed ([test/known.test.ts](test/known.test.ts)).

### Assurance tiers

The buyer chooses how much verification a job gets and pays for that, and providers compete within the tier they can satisfy. The tier is part of the job agreement, committed on HCS before work ([src/core/tiers.ts](src/core/tiers.ts)).

| Tier | What runs | Verifier fee | Who can serve it |
|---|---|---|---|
| `basic` | signed receipts, format and execution checks. No canaries, no known answers | 20% of standard | any provider |
| `standard` (default) | known answers in every chunk, hidden 0G canaries | standard | any provider |
| `high` | standard, and every chunk is run by **two independent providers** whose results must agree at the job's pass mark. A disagreement goes to a third, and the majority wins. Every chunk is paid at least twice | 150% | at least two admitted providers |
| `confidential` | standard, and only on 0G Compute services whose TEE signs every response, **TeeML on a 0G node** (not a TeeTLS relay); any chunk whose attestation doesn't verify is rejected | 125% | providers on attestable TeeML 0G services |

The verifier decides which copy a high-assurance chunk keeps, and records the agreement on HCS (`redundant` receipts). A provider outvoted by two others is recorded as disagreeing and quarantined, never slashed for it. `confidential` proves where the model ran; it doesn't hide the data from the KINETIC provider's own process, which decrypts the chunk before sending it to 0G. Choose a tier with `--tier` on `npm run live` / `npm run agent`, or in the dashboard's Run a job form. The passport's `summary.assurance` says whether the tier's promises held on every kept chunk, and lists any shortfalls.

### Choosing providers

The buyer agent doesn't just take the cheapest offer. It ranks every eligible offer from three things it can check ([src/agent/ranking.ts](src/agent/ranking.ts)):

- **Price:** the quote against the cheapest eligible quote.
- **Track record:** the verifier's pass/fail record for the provider on Arkiv, as `(pass + 1) / (pass + fail + 2)`, so a newcomer starts at 0.5 and one result doesn't decide everything.
- **Speed:** the provider's median measured latency against the fastest known one.

| Setting | What it does |
|---|---|
| `AGENT_STRATEGY` | `cheapest`, `balanced` (default) or `fastest`: how the three are weighted |
| `AGENT_MAX_PROVIDERS` | Only the best-ranked N work at once. The rest are **reserves** that step in when one goes offline, is slashed or hits its bond cap |
| `AGENT_MIN_RELIABILITY` | Skip providers below this reliability once they have 5+ checks |

The dashboard's **Run a job** form sets the strategy and the provider count per job. Every report and passport records each provider's score.

### Compute Passport

Every finished job gets a **Compute Passport** (`kinetic.passport.v2`): one public JSON file on 0G Storage, addressed by its Merkle root ([src/agent/passport.ts](src/agent/passport.ts)) that says how the results were produced, checked and paid for. It holds no input data and no keys. Its format is published as JSON Schema in [docs/compute-passport.schema.json](docs/compute-passport.schema.json) (`npm run passport:schema` regenerates it from the same definition the checker uses), so another application can check a passport without KINETIC's code or dashboard.

For every chunk it keeps two questions apart ([src/agent/assurance.ts](src/agent/assurance.ts)):

| | Field | What it records |
|---|---|---|
| **Where and how it ran** | `authenticity` | the method (`0g-direct`, `0g-router`, `self-hosted`), the declared and served model, the 0G node, the **guarantee** (`TeeML`, `TeeTLS`, `SPML`, `OpML`, `ZKML` or `none`, never merged), the verifier's own attestation check, and the request and response hashes. `model.hash` is `null`: neither 0G nor an OpenAI-compatible server publishes a hash of the weights |
| **Whether the answer was right** | `correctness` | the checks it passed and the strongest: `ground-truth` (known answers), `redundant-agreement` (two independent providers), `model-agreement` (a 0G canary) or `format-only` |

A TEE attestation says a response came out of a 0G service; it says nothing about whether the answer is right, and a passed known answer says nothing about which model ran. `TeeTLS` (a centralized 0G provider whose TEE vouches for the TLS route to an outside model) never counts as TeeML. Each chunk also carries an `inputCommitment`: an HMAC of its input items under a key only the buyer holds, so the buyer can later prove what was sent without the passport revealing it.

- **What else is in it:** the output hash; per chunk the provider, its signed result hash, its payment and any planted known answers; each provider's declared model, ranking, admission and status; the canary and known-answer commitments, reveals and scores; refunds, slashes (id, outcome, signers); and a list of what the passport does **not** prove.
- **`summary`:** the headline: verification `passed` / `partial` / `failed`, the assurance tier and whether it was met (with shortfalls), counts by correctness level and by attestation guarantee, known-answer and canary results, payment status and slash outcomes. It is derived from the chunks, so anyone can recompute it, and checkers do.
- **Who signs it:** the buyer signs it. The verifier co-signs only after comparing it with its own records: the canaries and known answers, each chunk's provider, result hash, payment and attestation, independent copies, the slashes, the fee, the policy and the summary. If anything differs, it refuses, and the passport says so.
- **Anyone can check it**, without keys:

```bash
npm run passport:verify -- <0G root> --results out/<jobId>.json
```

Offline, it checks the schema, both signatures, the canary and known-answer reveals against their commitments, every provider's signature on its result hash, that every authenticity and correctness claim and the summary follow from the evidence, every canary's 0G TEE signature, that spending stayed within the firm quote, and that your results file is exactly what the providers signed. Online (the default; `--offline` skips it), it also finds the job's receipts on HCS, the payments on the mirror node, and each slash's status and the co-signer among the verifiers in the vault, and that each canary's TEE signer is the one 0G's serving contract registers (`--zg-rpc` overrides the 0G mainnet RPC). It fetches the passport by its 0G root and checks the bytes against that root. Editing any field breaks the signatures; older `v1` passports still check.

### Firm quote

Before any work, the buyer agent prices the job from the live offers: every chunk plus a 25% allowance for reroutes and re-checks, at the highest price among the providers that might do the work, plus the verifier's fee exactly as the verifier computes it. That quote goes into the job agreement, whose hash is on HCS before work starts, and it is a hard ceiling: the agent stops paying once the next payment would cross it. The verifier refuses a quote whose fee doesn't match what it charges. The report says "paid X of the Y quoted", and `passport:verify` checks it. Refunds from slashed providers come back on top. Code: [src/core/quote.ts](src/core/quote.ts).

### Model check (fingerprinting)

Does a provider run the model it declares? Every capable model labels clear-cut tickets the same way, but borderline ones ("charged twice after the checkout crashed": billing or bug?) are answered differently by different models, and the same way each time by any one of them. `npm run fingerprint` measured 11 real models (10 on 0G, one local) on 40 borderline tickets and kept, for each model, 12 items that tell it apart ([data/fingerprints.json](data/fingerprints.json)). After a provider passes admission, the verifier pays it for two normal-looking chunks of its declared model's items and compares the answers.

Measured: honest providers on `0gm-1.0-35b-a3b` matched its fingerprint 75–100% (scripted runs and live testnet probes); one claiming that model but running `qwen2.5:3b` matched 50%, and one that never calls a model 33%. So the verdict is consistent at 75% or more, mismatch below 60%, and inconclusive in between. An earlier rule that also flagged a provider when another model matched better wrongly flagged honest `atlas` on testnet, because similar large models share answers; only the declared model's match decides now. So it reliably catches a provider that swaps in a smaller, cheaper model, which is what substitution pays for. It can't tell similar large models apart (`qwen3.5-flash` answers 0gm's items the same way), and a provider could run the declared model only on chunks it guesses are probes. So the result is evidence, never a reason to slash: an HCS `fingerprint` receipt, a "Model check" line on each provider card, the passport, and the voice agent's facts. Code: [src/core/fingerprint.ts](src/core/fingerprint.ts).

## The verifier agent pays its own way

The verifier is an agent with a budget in both directions:

- **It spends 0G credits.** Every canary is a reference run on 0G Private Computer in the `private` trust tier (TeeML only: the model runs inside the 0G provider's Intel TDX enclave, never a TeeTLS relay to an outside cloud), paid from the verifier's 0G credits; each run's cost (`x_0g_trace.billing`) is recorded with it. If no TeeML provider is free, the router answers `503 no_provider_for_trust_mode` and the run is repeated in `verified` mode, and the canary says so (`ZEROG_CANARY_FALLBACK=none` turns that off).
- **It checks the TEE signature itself.** The router's `tee_verified` is only its word, so for each canary the verifier looks the serving provider up in 0G's inference serving contract (0G mainnet, chain 16661: the router's providers are registered there, not on Galileo), fetches the signature from the provider's own endpoint (`GET {url}/v1/proxy/signature/{chatId}`, the chat id from `ZG-Res-Key`) and recovers it as EIP-191 against a TEE signer the provider registers on-chain (its `teeSignerAddress`, or the address of its separate target enclave when it has one), never the address the endpoint reports. A relay's separately signed routing proof must be present and cover the same exchange. The provider, chat id, signed text, signature, signer and result go into the Compute Passport, and `passport:verify` re-checks them. The router seals each request to the enclave (`X-0G-E2EE: sealed`), so the TEE signs hashes of the ciphertext (`zg-sig-v1/e2ee-ct:<request>:<response>`), which only 0G's attested E2EE gateway holds: the signature proves the registered enclave signed a sealed exchange under this response's chat id, but KINETIC can't recompute its binding to the plaintext answer. A signature that doesn't verify means no canary is scored on that run. Code: [src/integrations/zerog-tee.ts](src/integrations/zerog-tee.ts).
- **It earns HBAR.** Registering a job is an x402 payment to the verifier of `VERIFIER_FEE_PER_CHUNK_TINYBAR` per chunk (default 0.0001 ℏ), settled on Hedera before the canary set is committed.
- **It comes back every day.** 0G credits refresh daily and unused ones expire, so verification capacity is perishable. The verifier sells today's credits as checks on today's jobs, and every job that registers pays for the next day's work. Its earnings, 0G runs and credits spent are shown live on the dashboard.

### Providers run on 0G Compute

Each provider declares what it runs, and runs exactly that: `PROVIDER_BACKEND=0g` (the default) sends its chunks to 0G Private Computer with its own 0G key, on `0gm-1.0-35b-a3b`, 0G's own model, served by 0G Compute nodes in a TEE (TeeML). `PROVIDER_BACKEND=openai` runs on the operator's own OpenAI-compatible server (Ollama, vLLM, llama.cpp) instead. There's no fallback: a provider whose server isn't answering doesn't start. The declared backend is in the offer (`0g:0gm-1.0-35b-a3b`) and the passport. Code: [src/provider/backend.ts](src/provider/backend.ts).

The verifier checks providers against a **different** 0G model, `glm-5.3` (also TeeML), so a canary compares two independent models rather than a model with itself. The buyer pays a provider per chunk over x402; the provider pays 0G for the inference from its own credits.

### Payments are HBAR

Payments and bonds are both HBAR, so a slash refunds exactly what the buyer paid that provider, with no exchange rate in between. Earlier runs settled in KUSD, an HTS test token with an invented 1:1 HBAR refund rate; that's gone. The dashboard still labels those older receipts by their token, and `passport:verify` can still check their passports.

### Agent identity (HCS-14)

Each agent has an HCS-14 **Universal Agent ID**: the verifier, the buyer, and every provider. It's derived from a public profile (name, registry `kinetic`, protocol `x402`, HCS-11 skill codes, and the agent's Hedera account as a CAIP-10 `nativeId`) with the Hashgraph Online standards SDK.

- A provider publishes its profile and full UAID in its Arkiv offer, and the `uaid:aid:<hash>` key as a queryable attribute.
- The buyer recomputes the UAID from the profile and checks that it names the account the offer is paid at. An offer that fails is skipped, so a provider can't borrow another's identity or reputation.
- Reputation entities and the verifier's admission and slash receipts on HCS carry the provider's UAID; the verifier's own UAID is in its `/status`.

### Sign in with 0G

The **Sign in with 0G** button signs a user into their own 0G account (the one holding their daily iAI credits) through 0G's Privy app, which 0G shares with teams; set `VITE_PRIVY_APP_ID` in `web/.env`. The router turns the Privy token into a session (`POST /v1/auth/privy`), and the dashboard reads the account's credits (`GET /v1/account/balance`). **Pay my agent with my credits** creates a 24-hour API key on that account (`POST /v1/api-keys`) and hands it to the buyer agent, so the user's credits pay for their agent's own 0G calls from then on. Without the Privy app id, a 0G management key (`mk-…`, from pc.0g.ai → Settings) does the same. Code: [web/src/zerog.tsx](web/src/zerog.tsx).

## Partner integrations in the code

| | What | Where |
|---|---|---|
| **Hedera x402** | 402 quote → `exact` HBAR payment (partially signed `TransferTransaction`) → facilitator verify → work → settle | [src/integrations/x402.ts](src/integrations/x402.ts), [src/provider/node.ts](src/provider/node.ts) |
| **HCS-14** | Universal Agent IDs for every agent; buyers reject offers whose UAID doesn't match | [src/integrations/identity.ts](src/integrations/identity.ts), [src/agent/buyer.ts](src/agent/buyer.ts) |
| **Hedera EVM** | `KineticBondVault`: bond, timelocked withdraw, quorum-signed `proposeSlash()`, dispute window and challenge bonds, `executeSlash()` refunds the buyer and burns the rest | [contracts/KineticBondVault.sol](contracts/KineticBondVault.sol), [src/integrations/vault.ts](src/integrations/vault.ts) |
| **Hedera HCS** | Receipts for job commitment, every paid chunk, every canary, every slash, and the reveal; read back via mirror node | [src/integrations/hcs.ts](src/integrations/hcs.ts) |
| **0G Private Computer** | Providers run their chunks on 0G Compute (`0gm-1.0-35b-a3b`, TeeML). The verifier pays reference runs on `glm-5.3` (TeeML) from its 0G credits with `X-0G-Provider-Trust-Mode: verified`, keeps the `request_id`, the serving 0G node and the sealed end-to-end encryption marker (`X-0G-E2EE`), and earns an x402 fee per verified chunk | [src/provider/backend.ts](src/provider/backend.ts), [src/integrations/zerog.ts](src/integrations/zerog.ts), [src/verifier/service.ts](src/verifier/service.ts) |
| **Arkiv** | offers, claims, jobs, chunks, reputation, and one expiring entity per check (the live record buyers rank on); batched writes with `@arkiv-network/sdk`; buyers discover offers by query; the dashboard reads Arkiv through the verifier's cached `GET /arkiv/:kind` (one query per kind for every viewer, access key kept server-side) | [src/integrations/arkiv.ts](src/integrations/arkiv.ts), [src/verifier/service.ts](src/verifier/service.ts), [web/src/data.ts](web/src/data.ts) |
| **0G Storage** | Model weights, Model Passports and Compute Passports, each addressed by its 0G Merkle root and checked against it on every download; the verifier stores passports and pays the storage fee from its own 0G wallet, and serves them at `GET /passports/:root` because 0G's indexer sends no CORS headers | [src/integrations/zg-storage.ts](src/integrations/zg-storage.ts), [src/integrations/storage.ts](src/integrations/storage.ts), [src/verifier/service.ts](src/verifier/service.ts) |

### Arkiv entities

Every entity has an `app` attribute (default `kinetic`) and is written through a named schema `kinetic.<kind>` (below). The full schema is in [arkiv/schema.md](arkiv/schema.md).

| kind | Owner | Queryable attributes | Expires | Payload |
|---|---|---|---|---|
| `offer` | provider | `provider`, `pay_to`, `name`, `endpoint`, `gpu`, `price`, `bond`, `uaid`, `task.classify` / `task.extract` / `task.tag`, `adversarial` on an adversarial test provider, and `hcs10_inbound` once listed in the Hashgraph Online registry | 90 s, renewed every 30 s by the provider's heartbeat, so a dead node disappears | compute, declared backend (e.g. `0g:0gm-1.0-35b-a3b`), network, HCS-14 profile |
| `claim` | buyer | `job_id`, `idx`, `provider` | 2 min lease | — |
| `job` | buyer | `job_id`, `task`, `status`, `total`, `done`, `rerouted`, `paid`, `refunded`, `fee`, `audit_ref` | 7 days | task kind, label names |
| `chunk` | buyer | `job_id`, `idx`, `status` (`pending`/`claimed`/`done`/`verified`), `provider` | 7 days | — |
| `reputation` | verifier | `provider`, `pass`, `fail`, `score`, `status` (`ok`/`slashed`), `window` (recent checks), `adversarial` (kept after its offer expires) | 30 days, extended on every canary | — |
| `check` | verifier | `provider`, `src` (`canary`/`format`/`execution`/`admission`), `pass` (1/0), `at`, and `job_id`, `idx` for job checks | 7 days, never extended | — |
| `model` | verifier | `mkey`, `model_id`, `version`, `status`, `task.<kind>`, `name`, `creator`, `engine`, `passport_ref`, `passport_digest`, `royalty_bps`, `accuracy` | 30 days, renewed by the verifier | the listing: card, Model Passport reference and digest, signers |

Arkiv records are public and expire: they hold coordination state and commitments, never data or keys. The permanent evidence is elsewhere: every check, slash and settlement is an HCS receipt (kept by the mirror node), and each job's Compute Passport is on 0G Storage. A `check` entity is a convenience index over those receipts, so its 7-day expiry loses nothing.

Each kind is written through a named Arkiv schema (`kinetic.offer`, `kinetic.check`, …) with typed columns (`addr` for addresses, `key` for links between entities), and checks are created `readonly`. Buyers only trust offers created and owned by the provider in their `provider` attribute, reputation created and owned by the verifier, and checks created by it (Arkiv's `$creator` never changes, even if an entity is handed over). A provider's live record is the count of its unexpired `check` entities: results older than 7 days drop out by themselves, so no operator has to keep a flag current. Buyers rank on that record when there is one, and label each provider `active` (a pass in the last 6 hours), `stale` or `unproven`. A query to find classification offers:

```
arkiv.schema = str('kinetic.offer') AND app = str('kinetic') AND task.classify = u64(1)
```

Offers last 90 s, so that query finds something only while providers are running. The model listings last 30 days. To list them with `curl` on Rabdi (chain 7794095). The public RPC is heavily rate limited; with an access key from [hub.arkiv.network](https://hub.arkiv.network/access-keys), add it to the end of the URL:

```bash
curl -s -X POST https://rpc.rabdi.db-chain.testnet.arkiv.network/ -H "Content-Type: application/json" -d \
  "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"arkiv_query\",\"params\":[\"arkiv.schema = str('kinetic.model') AND app = str('kinetic') AND status = str('listed')\",{\"limit\":20,\"select\":{\"key\":true,\"attributes\":true}}]}"
```

The wallets that write these entities:
- the buyer [`0x8ed8…73a6`](https://rabdi.explorer.arkiv.network/address/0x8ed8a58f08a2caa800cbb4083e3691e5ca1e73a6) writes jobs, chunks and claims;
- the verifier [`0xa19c…adc8`](https://rabdi.explorer.arkiv.network/address/0xa19cc96ea9f0e414cebb149918e4c5549554adc8) writes checks, reputation and model listings;
- each provider writes its own offer. Their addresses are in [evidence/README.md § 4](evidence/README.md#4-arkiv-holds-and-updates-the-marketplace).

The dashboard doesn't poll Arkiv: the verifier follows Arkiv's entity events (`watchEntityEvents`), re-reads only the entity that changed with `getEntity` (not metered), and pushes each change to the dashboard over Server-Sent Events (`GET /arkiv/events`); a full read every few minutes corrects anything missed. `GET /arkiv/stats` on the verifier reports the metered reads it made against what polling would have spent.

### Privacy

- **Data:** each chunk is encrypted (AES-256-GCM) with its own key, derived by HKDF from a per-job master key. Nothing is uploaded: the sealed chunk travels as base64 in the `data` field of the paid `POST /v1/chunks` request, and to the verifier when the job registers.
- **What each party gets:** a provider receives the sealed chunk and that one chunk's key inside its paid request, and the key is **wrapped to the provider's own public key** (ECIES on secp256k1, published in its Arkiv offer) and bound to that job, chunk and provider, so only that provider can open it and it can't be replayed into another request ([src/util/wrap.ts](src/util/wrap.ts)). The buyer sends no unwrapped key unless `AGENT_ALLOW_PLAIN_KEYS=true`. The verifier gets the job key, because it opens canary chunks for 0G and plants known answers.
- **What revocation can and can't do:** every chunk has its own key, so a provider that is slashed, quarantined or goes offline never gets the keys of later chunks: that is revocation for future work. It can't take back a chunk a provider already opened: the plaintext and the key are with it. Treat any chunk a provider received as seen by it.
- **What goes on Arkiv:** nothing about a chunk's contents. Chunk entities hold only the job, index, status and provider.
- **What is public on purpose:** each finished job has an unencrypted [Compute Passport](#compute-passport) (hashes, signatures, canary commitment and reveal, payments, refunds and slash transactions; no data, no keys). The buyer signs it, the verifier co-signs it, and the buyer sends it to the verifier's `POST /jobs/:id/passport`; the verifier stores it on 0G Storage, paying the fee from its own 0G wallet, and only if it is signed by the job's buyer and, when the verifier co-signed, is the exact passport it co-signed. Its 0G root goes on the job entity as `audit_ref`, so anyone can open it from the dashboard or at `https://indexer-storage-testnet-turbo.0g.ai/file?root=<root>`. If storing fails, the job still completes and the report says the passport wasn't stored. Jobs from before the passport have a plain audit bundle (`kinetic.audit.v1`) there instead.

---

## Live testnet evidence

### Current deployment (2026-11-05)

**Start with [evidence/README.md](evidence/README.md).** For each sponsor it links the records that show the claim, from one full job on the current deployment, and it includes the job's Compute Passport and a `passport:verify` run that passes every check.

| | |
|---|---|
| Bond vault | [`0x5850…b48a`](https://hashscan.io/testnet/contract/0x585054f20af2c3023156c10a3ee4bdeed90bb48a), source [verified on Sourcify](https://repo.sourcify.dev/296/0x585054f20af2c3023156c10a3ee4bdeed90bb48a) |
| HCS topic | [`0.0.11212792`](https://hashscan.io/testnet/topic/0.0.11212792) |
| Arkiv | Rabdi (chain 7794095); buyer [`0x8ed8…73a6`](https://rabdi.explorer.arkiv.network/address/0x8ed8a58f08a2caa800cbb4083e3691e5ca1e73a6), verifier [`0xa19c…adc8`](https://rabdi.explorer.arkiv.network/address/0xa19cc96ea9f0e414cebb149918e4c5549554adc8) |
| ERC-8004 (0G Galileo) | verifier agent 567, GPUs 566, 568, 570, 571, 575 |

Job `job-mw3qzkrd-585265` (48 tickets in 16 chunks, standard tier):
- **QuickCompute was caught and slashed.** It missed the planted known answers after admission. Both cosigners re-checked and signed, and the vault's own scheduled call executed the slash after the dispute window: the buyer got **0.003 ℏ** back and **0.997 ℏ** of the bond was burned ([proposal](https://hashscan.io/testnet/transaction/0x322073a9f5ee206a5109bb7a42041aaaf775f50e0503db9d9b9964835a9da2f8), [scheduled execution](https://hashscan.io/testnet/transaction/0xa1026d293e6cb21fe302fc0fa6f2661326191397bf547a41b0a244013a18bdaf)).
- **The other adversarial providers were handled too.** BudgetGPU was rejected at admission, and EdgeRelay went offline holding a payment, which was found on the ledger and reported; its chunks were rerouted.
- **0G checked the work.** 4 canaries re-run on 0G `glm-5.3` (TeeML only) agreed 100%, with each TEE signature checked against 0G's serving contract. A PRNG spot check drawn after the reveal agreed too.
- **Totals:** providers paid 0.0212 ℏ, refunded 0.003 ℏ, verifier fee 0.0016 ℏ, net 0.0198 ℏ.

Getting there turned up two bugs, both fixed and covered by tests:
- **0G's signer changed.** 0G's `glm-5.3` providers started registering a separate target enclave (`TargetSeparated`), while their sealed router exchanges are still signed by the service's own `teeSignerAddress`. KINETIC checked only the target address, so every canary went unscored. It now accepts either signer that the provider registers on-chain.
- **The self-settling vault never fired.** Version 3 booked its call for the exact closing second, so it ran as a no-op. On top of that, the verifier sometimes lacked the balance to pay for scheduling. No slash had ever executed itself before this run. The vault is now version 4, with the 10 s delay.

Earlier deployments, now retired: `0x9142…26d3` and `0x4dcb…3084` (version 3), `0x11d7…b294` (version 2), `0x0196…bee6` (version 1, single verifier). Jobs on them are below.

### Quorum vault, known answers and Passport v2 (2026-10-31)

On the quorum vault [`0x11d7…b294`](https://hashscan.io/testnet/contract/0x11d76cec886b06d5f8e7f4e7d9a5fa2c9808b294) (2 of 3 verifiers to slash, 3 to decide a dispute, 60 s dispute window), same HCS topic, providers on 0G through the router.

| Job | Tier | What happened |
|---|---|---|
| `job-mvwaz0se-30ab3a` | standard | 12/12 chunks. `cheapo` missed the planted known answer in 3 chunks; both cosigners re-checked and co-signed; the slash was [proposed with 3 signatures](https://hashscan.io/testnet/transaction/0x20838849dc59e35d877cd4be7c8ec8693f9f080e29c9c00be33fa38baddf654a) and, after the window, [executed](https://hashscan.io/testnet/transaction/0x091ca9fdce8ac67e3b7ec2e12e2561b3cd1cb8d762ab8f9ab0857f18bfc5012e): 0.0018 ℏ refunded, the other 0.9982 ℏ of its bond burned. The passport passed all 31 checks |
| `job-mvwbh75h-905568` | high | 6/6 chunks, each run by `atlas` and `nimbus` and agreeing 100%; `flicker` went down holding one payment, found on the ledger. The passport: tier met, every chunk ground truth, and authenticity `none` (the 0G router returns no per-chunk attestation, so none is claimed) |
| (not started) | confidential | refused before registering or paying: no provider runs on an attestable TeeML 0G node |

**Ten tasks, live (2026-10-31).** One standard-tier job per task through the dashboard network (`npm run live -- --serve`, jobs started from its agent service), 18 items in 6 chunks each. Every job completed, every chunk answered its planted known answer (6/6 on each), no honest provider was slashed, `shoddy` was rejected at admission on every task, and every passport passes all checks online:

| Task | Job |
|---|---|
| `classify-tickets` | `job-mvwdbytl-d6a831` |
| `sentiment` | `job-mvwdgh3p-a7f82e` |
| `language` | `job-mvwdk4ib-9e6fb7` |
| `news-topic` | `job-mvwdof3x-20c0d4` |
| `spam` | `job-mvwdsppc-8e59cb` |
| `intent` | `job-mvwdw5ej-13522e` |
| `animal-class` | `job-mvwe1qcq-ac305e` |
| `ticket-tags` | `job-mvwe4ybh-0bd1c0` |
| `ticket-fields` | `job-mvwe8tfm-1c298f` |
| `invoice-fields` | `job-mvwec1fa-3f98c4` |

Seen on the way: the public x402.org facilitator answered HTTP 520 to several verify and settle calls (one provider missed admission, a few chunks were rerouted, none charged). A tampered copy of the standard passport (inflated summary, a TEE it never had) fails `passport:verify` on both claims and both signatures.

### Before the quorum vault: providers on 0G Compute, paid in HBAR

Job `job-mvuj3yuh-f230e4` labelled 60 tickets in 20 chunks with every provider on 0G Compute (`0gm-1.0-35b-a3b`), checked against `glm-5.3`, paying in HBAR. The buyer agreed before work to have half the chunks checked against 0G (`--canary-rate 0.5`).

| Provider | Runs | Admission (known answers) | What happened |
|---|---|---|---|
| `atlas` | 0G | ✓ 100% | did all 20 final chunks, including the 4 rerouted from `cheapo`; every canary passed |
| `cheapo` (adversarial) | 0G, then nothing | ✓ 100% | stopped calling its model after admission, failed 3 canaries, **slashed**; buyer **refunded 0.0042 ℏ**, its 4 chunks rerouted |
| `flicker` (adversarial) | 0G | ✓ 100% | went down mid-chunk; the 0.0008 ℏ payment it kept was found on the ledger and reported as paid but undelivered |
| `shoddy` (adversarial) | nothing | ✗ 0% | **rejected at admission**, never paid for job work |
| `nimbus` | 0G | ✗ | honest, but its 0G call errored (HTTP 500) during the admission probe, so it got no work. A real failure, not a scripted one |

The network also failed for real along the way, and KINETIC handled it: the x402.org facilitator returned Cloudflare 520 errors on two settlements (those chunks were never charged and were rerouted), and one 0G reference run failed, so that canary went unscored instead of counting against anyone.

Result: 20/20 chunks; providers paid 0.025 ℏ, refunded 0.0042 ℏ, verifier fee 0.002 ℏ, net 0.0228 ℏ. `npm run passport:verify` passes all 20 checks against HCS, the mirror node and the vault.

- x402 verification fee: [0.0.9185802-1793337956-280387601](https://hashscan.io/testnet/transaction/0.0.9185802-1793337956-280387601)
- x402 chunk payment: [0.0.9185802-1793338353-099362889](https://hashscan.io/testnet/transaction/0.0.9185802-1793338353-099362889)
- Slash with refund (`cheapo`): [0x577d…bd11](https://hashscan.io/testnet/transaction/0x577d009bdac7af38b7f7c1989621bc9bd3dc46c3c78757aef0714a688caabd11)
- 0G reference runs on `glm-5.3`, e.g. requests `d9ca9fe9-17cb-4f85-b19a-2710b8794d11`, `fd09083e-54ac-4899-a70d-ef676d050776`
- Arkiv: the buyer [`0x8ed8…73a6`](https://tiramisu.explorer.arkiv.network/address/0x8ed8a58f08a2caa800cbb4083e3691e5ca1e73a6), the verifier [`0xa19c…adc8`](https://tiramisu.explorer.arkiv.network/address/0xa19cc96ea9f0e414cebb149918e4c5549554adc8), `cheapo`'s new account [`0x29a7…9005`](https://tiramisu.explorer.arkiv.network/address/0x29a727ad41ed785ceff13833123d3b33cd1f9005). Query: `app = str('kinetic') AND kind = str('job') AND job_id = str('job-mvuj3yuh-f230e4')`
- Evidence file: `out/live-job-mvuj3yuh-f230e4.md`

### Earlier runs

These are real transactions too, made before the changes described above: the providers had their old names (`atlas-4090`, `cheapo-3060`, …) and ran on Ollama or on 0G as an undeclared fallback, the referee was `qwen3.7-flash`, and two runs paid in KUSD.

### Paid in KUSD (HTS)

Job `job-mvtbwqvv-fb6b43` labelled 60 tickets in chunks of 3 with a budget of 1 KUSD. Every x402 payment settled in KUSD through the public facilitator.

| Provider | Admission | What happened |
|---|---|---|
| `nimbus-a100` | ✓ 100% | did 19 of the 20 chunks |
| `cheapo-3060` | ✓ 100% | failed 3 canaries, **slashed**; buyer **refunded 0.0054 ℏ** for its 0.0054 KUSD of payments, 6 chunks rerouted |
| `flicker-t4` | ✓ 100% | crashed mid-job; the payment it kept without answering was found on the ledger and reported |
| `shoddy-1060` | ✗ 17% | rejected at admission |
| `atlas-4090` | timed out | its admission probe was paid, but its model call hung for 180 s, so it got no work (it's re-probed after 2 minutes) |

Result: 20/20 chunks; providers paid 0.0298 KUSD, verifier fee 0.002 KUSD, refunded 0.0054 ℏ.

- KUSD token: [0.0.11220110](https://hashscan.io/testnet/token/0.0.11220110)
- x402 chunk payment in KUSD: [0.0.9185802-1793265974-983692671](https://hashscan.io/testnet/transaction/0.0.9185802-1793265974-983692671)
- x402 verification fee in KUSD: [0.0.9185802-1793265395-911030960](https://hashscan.io/testnet/transaction/0.0.9185802-1793265395-911030960)
- Slash with refund: [0x7701…3453](https://hashscan.io/testnet/transaction/0x77014040725c9eff004b691df0fbecea006a4d8b1dc6ae72ff78316a4f013453)
- HCS receipts #89–#134 on [0.0.11212792](https://hashscan.io/testnet/topic/0.0.11212792): chunk and close receipts name the token (`"asset":"0.0.11220110"`), slash and admission receipts carry the provider's HCS-14 UAID.

### Paid in HBAR

Job `job-mvsji5xu-9915f8` labelled 60 tickets in 20 chunks on Hedera testnet, Arkiv Tiramisu and 0G Private Computer, with five real provider accounts:

| Provider | Admission (known answers) | What happened |
|---|---|---|
| `atlas-4090`, `nimbus-a100` | ✓ 100% | did 19 of the 20 chunks, all canaries passed |
| `cheapo-3060` | ✓ 100% | cut corners after admission, failed 3 canaries, **slashed**; buyer **refunded 0.0036 ℏ**, 3 chunks rerouted |
| `flicker-t4` | ✓ 100% | crashed mid-job; the payment it kept without answering was found on the ledger and reported |
| `shoddy-1060` | ✗ 17% | **rejected at admission**, never paid for job work |

Result: 20/20 chunks complete; providers paid 0.026 ℏ, refunded 0.0036 ℏ, verifier fee 0.002 ℏ, net 0.0244 ℏ.

- **Hedera**
  - HCS audit topic: [0.0.11212792](https://hashscan.io/testnet/topic/0.0.11212792)
  - Bond vault: [0x0196…bee6](https://hashscan.io/testnet/contract/0x019631c2acfeb747dfc6b9ca388cefc83833bee6)
  - x402 verification fee, buyer → verifier: [0.0.9185802-1793217726-780680044](https://hashscan.io/testnet/transaction/0.0.9185802-1793217726-780680044)
  - x402 chunk payment, buyer → provider: [0.0.9185802-1793217967-058498751](https://hashscan.io/testnet/transaction/0.0.9185802-1793217967-058498751)
  - Slash with refund to the buyer: [0x8f4f…8c27](https://hashscan.io/testnet/transaction/0x8f4f088b6463cafeab34c78a3d5455d02ba004dc996ebe95df42addb5c8b8c27)
- **0G Private Computer**: verified reference runs, for example request `0533d7b7-547c-49f2-932f-ce7fd09c2a3d` (`qwen3.7-flash`, TeeTLS).
- **Arkiv**: entities written by the buyer [`0x8ed8…73a6`](https://tiramisu.explorer.arkiv.network/address/0x8ed8a58f08a2caa800cbb4083e3691e5ca1e73a6), the verifier [`0xa19c…adc8`](https://tiramisu.explorer.arkiv.network/address/0xa19cc96ea9f0e414cebb149918e4c5549554adc8), and each provider. Query: `app = str('kinetic') AND kind = str('job') AND job_id = str('job-mvsji5xu-9915f8')`.

The honest providers in the two runs above used the 0G model as a stand-in for a community GPU (no local model server was running). The known-answer admission check is what keeps that from being circular: it's scored against true labels, not against 0G.

### On a local model (Ollama, CPU only)

Job `job-mvterakx-44ac85` ran with every provider on **Ollama `qwen2.5:3b-instruct` on a CPU-only laptop** (Intel integrated graphics, 16 GB RAM), paid in KUSD: 10/10 chunks, atlas-4090 and nimbus-a100 admitted at 100% of known answers, shoddy-1060 rejected at 33%, and all three hidden canaries agreed 100% with 0G's `qwen3.7-flash` (0G requests `f241f41a…`, `5df8eed9…`, `1d27d379…`). `npm run calibrate` on the same setup: 100% of known answers, 100% agreement with 0G over 6 chunks, a lazy provider at most 33%, about 12 s per chunk.

## Running on testnets

Everything below talks to the real networks: Hedera testnet (x402 through the public testnet facilitators, `x402.org` first with Blocky402 and Launa as failover, set by `X402_FACILITATOR_URLS`; HCS, the vault on the EVM through Hashio), Arkiv Rabdi, and 0G (Private Computer and Storage).

**What you need (KINETIC cannot create these for you):**

| | How to get it | Used for |
|---|---|---|
| One Hedera testnet account | [portal.hedera.com](https://portal.hedera.com): create an ECDSA account, copy its id and key | creates and funds every role's account |
| One Arkiv testnet wallet with gas | [hub.arkiv.network/faucet](https://hub.arkiv.network/faucet) (fund the Hedera key's EVM address, or any key) | gives every role gas for Arkiv writes |
| An Arkiv access key (recommended) | [hub.arkiv.network/access-keys](https://hub.arkiv.network/access-keys), set as `ARKIV_API_KEY` | lifts the anonymous RPC rate limit that five providers plus a dashboard can hit |
| A 0G Private Computer API key with credits | [pc.0g.ai](https://pc.0g.ai) | providers' work and verifier reference runs |

**Three commands:**

```bash
# 1. Create every role (verifier, buyer, five providers) on Hedera with an ECDSA alias, keys for
#    two cosigning verifiers, the HCS topic (verifier is the only submitter), the vault (2 of the 3
#    verifiers sign a slash), fund Arkiv gas, and write .kinetic/testnet/<role>.env
OPERATOR_ID=0.0.xxxx OPERATOR_KEY=0x... ARKIV_FUNDER_KEY=0x... ARKIV_API_KEY=... ZEROG_API_KEY=... npm run setup:testnet

# 2. Read-only preflight: accounts, aliases, balances, topic, vault verifiers and quorum, facilitator,
#    0G model verifiability and credits, 0G Storage (indexer reachable, verifier has 0G for fees), Arkiv gas
npm run doctor

# 3a. Run one real job end to end and write the evidence file
npm run live

# 3b. Or bring the network up for the dashboard and start jobs from "Run a job"
npm run live -- --serve          # add --job to also run one job at startup
npm run web                      # second terminal, then open http://localhost:5173
```

`npm run live` also starts the two cosigners (ports 4510 and 4520); they need `ZEROG_API_KEY` to re-run failed canaries. A vault from before quorum slashing is replaced by `setup:testnet`; providers bonded in the old one can still `requestWithdraw` there. Slashes wait out a 60 s dispute window (`VAULT_DISPUTE_WINDOW`), so a job with a slash finishes about a minute later.

Slashing is permanent for an address, so after a run where `QuickCompute` is slashed, buyers skip it. To have it caught again in a new run, give it a fresh account: `npm run setup:testnet -- --rotate provider-3`.

`npm run live` writes `out/live-<jobId>.md` with the evidence:
- HashScan links for x402 payments, the verifier fee, the slash and the HCS topic.
- 0G request ids for the canaries.
- The Arkiv wallet addresses that wrote entities, with a query to run.
- The Compute Passport's 0G Storage root and link, and the command to check it.

**Your own GPU instead of 0G.** A provider can run on its operator's own OpenAI-compatible server (Ollama, vLLM, llama.cpp) instead of 0G Compute. It then declares that backend, and if the server isn't answering at startup the provider doesn't start. On a laptop without a GPU:

```bash
winget install Ollama.Ollama          # or the installer from ollama.com
ollama pull qwen2.5:3b-instruct       # ~2 GB; on a GPU, qwen2.5:7b-instruct
# in .kinetic/testnet/provider-*.env:
#   PROVIDER_BACKEND=openai
#   PROVIDER_MODEL_URL=http://localhost:11434/v1
#   PROVIDER_MODEL=qwen2.5:3b-instruct
npm run calibrate                     # check the model before a live run
```

`npm run calibrate` runs the local model and 0G on the same chunks and reports its accuracy on known answers, its agreement with 0G, how a lazy provider scores, and seconds per chunk, then suggests a `CANARY_MIN_AGREEMENT` between the two. A threshold above an honest model's agreement would slash honest providers, so run it whenever the model changes. To serve a GPU on another machine, start Ollama there with `OLLAMA_HOST=0.0.0.0` and point `PROVIDER_MODEL_URL` at it.

**Confidential assurance on testnet.** It needs providers that call one attestable TeeML 0G Compute service directly (`PROVIDER_BACKEND=0g-compute`), paid from a 0G testnet wallet's compute ledger: about 3 0G for the ledger plus 2 0G per provider. On 2026-10-31 one service qualified (`0x1cb95eb66cc67c62d4de0cc96726c5a5d82e7c85`, 0GM-1.0-35B-A3B on a 0G node). With a wallet funded from the [0G faucet](https://faucet.0g.ai) and its key as `ZG_PRIVATE_KEY` in `.env`:

```bash
npm run zerog -- assign --only-attestable --yes   # providers onto attestable TeeML services
npm run zerog -- plan                             # wallet, ledger and cost check (read-only)
npm run zerog -- fund --yes                       # create the ledger and fund each provider's sub-account
npm run live -- --tier confidential               # restart the network on them and run a confidential job
```

**Bonds.** `npm run bonds` shows every role's bond in the current vault and in any vault an earlier setup replaced; `request --yes` starts the 24 h withdrawal delay, `withdraw --yes` takes out what's due. A requested provider gets no new work. Retired role keys can be passed with `--keys .kinetic/testnet/retired-keys.json`.

**Outside providers.** [docs/RUN_A_PROVIDER.md](docs/RUN_A_PROVIDER.md) takes an operator from nothing to a live provider, and ends with an invitation you can send.

**Running roles as separate processes.** Each role is also its own program: `npm run verifier`, `npm run cosigner`, `npm run provider`, `npm run agent`. Copy a role's env file to `.env` (or export its variables) before starting it. The manual steps `npm run keys`, `npm run create:topic` and `npm run deploy:vault` still exist if you'd rather not use `setup:testnet`.

**Run a provider of your own.** Nothing about a provider is tied to the operator of the verifier: anyone with a Hedera testnet account and compute can join the same network, and buyers treat it exactly like the others (identity check, bond in the vault, paid admission probe, hidden canaries).

```bash
npm run keys                          # fresh secp256k1 keys (use the provider one); create an ECDSA
                                      # Hedera testnet account for it and fund it at the Arkiv faucet
# .env, with the network's shared values from the verifier's operator:
#   KINETIC_NETWORK=testnet  KINETIC_PRIVATE_KEY=0x…  HEDERA_ACCOUNT_ID=0.0.…
#   HCS_TOPIC_ID=0.0.…  BOND_VAULT_ADDRESS=0x…  ARKIV_API_KEY=…
#   PROVIDER_NAME=…  PROVIDER_PUBLIC_URL=https://your-host:5101  PROVIDER_PRICE_TINYBAR=…
#   PROVIDER_BACKEND=0g ZEROG_API_KEY=…   (or PROVIDER_BACKEND=openai PROVIDER_MODEL_URL=… for your own GPU)
npm run provider                      # bonds PROVIDER_BOND_TINYBAR, publishes the offer on Arkiv, serves /v1/chunks
npm run register:hol                  # optional: list it in the Hashgraph Online registry (HCS-10)
```

`PROVIDER_PUBLIC_URL` must be reachable by buyers; the offer advertises it. The bond can only leave the vault after `requestWithdraw` and the 24 h delay, and never while a slash against it is open. `npm run register:hol` creates the provider's HCS-10 topics and HCS-11 profile from its own account, registers it with the Hashgraph Online guarded registry, and writes `HOL_INBOUND_TOPIC_ID`, which the next offer publishes as `hcs10_inbound`. KINETIC runs on testnets only: Arkiv has no mainnet yet, and nothing here has been run with real funds.

**Tuning.** `CANARY_RATE`, `CANARY_WINDOW`, `CANARY_FAIL_LIMIT` and `CANARY_MIN_AGREEMENT` set the policy. The defaults (25%, 3 of 10, 0.8) are starting points. Measure how often an honest provider on your model agrees with the 0G reference, then set the threshold well below that.

## Tests

```bash
npm test          # 159 tests: the vault contract in an in-process EVM, everything else on a local emulator
                  # (`npm run smoke:hedera` hits Hedera testnet)
npm run typecheck
```

The suites run on a local emulator of Hedera, Arkiv and 0G in [test/support/](test/support/), so they're fast and free. It speaks the same wire formats as the real networks and enforces the same rules (entity ownership and expiry, quorum-signed slashing with its dispute window, files addressed by their 0G root), with a deterministic keyword model in place of 0G so answers are checkable. It exists only for the tests: KINETIC refuses `KINETIC_NETWORK=devnet` outside the test runner.

- [test/core.test.ts](test/core.test.ts): chunking, canary selection, commit and reveal, the slash window, scoring, prompt parsing, encryption, format validation; providers run exactly the backend they declare, and only adversarial ones are labelled.
- [test/integration.test.ts](test/integration.test.ts): the x402 gate. It covers the 402 quote, settlement, no charge on failure, budget refusal, replay rejection, and reconciling a payment whose response was lost. It also checks Arkiv ownership and expiry.
- [test/arkiv-queue.test.ts](test/arkiv-queue.test.ts): the Arkiv write queue never strands a write and merges patches (a bug the first live run found).
- [test/e2e.test.ts](test/e2e.test.ts): the full scenario on the emulator.
  - Every final label matches the reference.
  - The provider that's lazy from the start is rejected at admission and never paid for job work.
  - The lazy provider is slashed and refunded in full; the offline one is routed around.
  - Adversarial providers carry their label in the report, and are still admitted and paid until they're caught.
  - The buyer's balance falls by exactly paid minus refunded plus the verifier's fee.
  - The Compute Passport is co-signed by the verifier, stored on 0G Storage, and passes every offline and online check; a changed result fails.
  - The HCS reveal matches the commitment.
  - With two providers at once, reserves step in when the first choices are slashed or go offline, and the job still completes.
  - A buyer's stricter rules and own examples are committed on HCS, applied, charged for, and met; a deadline that passes stops paid work and the passport says the agreement wasn't met.
- [test/vault-contract.test.ts](test/vault-contract.test.ts): the compiled `KineticBondVault` in an EthereumJS EVM. The digest it checks matches the one verifiers sign; a slash needs a quorum of distinct verifiers in address order; signatures over a different chunk, result, refund or evidence fail; it waits out the dispute window, refunds, burns the rest only once no other slash is open, and freezes withdrawals meanwhile; disputes are upheld, overturned or cancelled at the timeout.
- [test/quorum.test.ts](test/quorum.test.ts): slashing on the emulator with three verifiers. 2 of 3 sign after re-checking and the slash executes with a refund and a burn; cosigners that don't confirm the failures block it (`slash-refused`, quarantine instead); a disputed slash is upheld by all three and the buyer also gets the challenge bond; one the verifiers can't agree on is cancelled at the timeout and the provider keeps its bond. Every check is an expiring Arkiv entity and the next job ranks on them.
- [test/tasks.test.ts](test/tasks.test.ts): ten labelled sets load, each fits only its own task, true outputs for classify, tag and extract; extraction jobs plant their own task's known answers and admit on them.
- [test/known.test.ts](test/known.test.ts): known answers. The labelled set splits into disjoint admission and planting halves; one item is planted per chunk under a lookalike id and committed; the lazy provider is slashed on missed known answers, which stay out of the results; the passport reveals where they were and passes every check; with the 0G reference disagreeing with every honest answer, honest providers are never slashed, and under the old rule they are.
- [test/tiers.test.ts](test/tiers.test.ts): assurance tiers. Fees and quotes by tier; basic runs no canaries and says its results are format-only; high keeps a chunk only when two independent providers agree, and pays each chunk at least twice; confidential uses only TeeML-attested 0G nodes (a TeeTLS relay is excluded) and every kept chunk's attestation verified.
- [test/wrap.test.ts](test/wrap.test.ts): wrapped chunk keys open only with the provider's key and the same job, chunk and provider, and refuse tampering.
- [test/ranking.test.ts](test/ranking.test.ts): provider ranking by price, track record and speed for each strategy.
- [test/passport.test.ts](test/passport.test.ts): passport v2 matches its schema and derives every claim from the evidence; TeeML and TeeTLS stay separate; a passport that claims more correctness, a TEE it didn't have, or a rosier summary is caught even when re-signed. It also detects edits, results that differ from what providers signed, unbacked "verified" claims, a bad canary reveal, chunks below the agreed pass mark and an overstated outcome; agreements never go below the network's rules and must match what the verifier receives.

## Layout

```
contracts/KineticBondVault.sol   bonds, quorum slashing, disputes, refunds and burns (Hedera EVM)
src/core/                         chunking, canaries (commit/reveal), slash policy and signed verdicts, job agreement, tiers
src/tasks/                        prompts, output parsing, scoring
src/integrations/                 x402, HCS, vault, Arkiv, 0G (Compute, Storage), mirror node
src/provider/                     provider node: bond, Arkiv offer, x402-gated /v1/chunks
src/verifier/                     verifier agent: known answers, canaries, 0G references, slashing; cosigners that re-check
src/agent/                        buyer agent: rank, split, pay, verify, reroute; Compute Passport v2 and its schema
src/testnet/                      role table and env files for testnet runs
src/live.ts                       the whole system on the real networks
test/support/                     the tests' local emulator, scenario runner and keyword model
web/                              live dashboard (Vite + React)
scripts/                          setup:testnet, doctor, passport:verify, keys, vault deploy, HCS topic, dataset,
                                  migrate:passports, register:hol
arkiv/                            how KINETIC uses Arkiv: schema, rationale, feedback
data/                             sample tickets and task specs
```

## Sponsor requirements

| Prize | Requirement | Where |
|---|---|---|
| **Hedera · x402** | x402-protected endpoint settling on Hedera testnet through a listed facilitator | `POST /v1/chunks` on every provider and `POST /jobs` on the verifier, settled through `x402.org`, failing over to Blocky402 and Launa ([src/integrations/x402.ts](src/integrations/x402.ts), [src/config.ts](src/config.ts)) |
| | An agent finds the endpoint and completes a paid request with no human approving | the buyer agent discovers offers on Arkiv and pays per chunk ([src/agent/buyer.ts](src/agent/buyer.ts)) |
| | README with setup, architecture, payment flow and a settled Hedera transaction id | [How a job runs](#how-a-job-runs), [Live testnet evidence](#live-testnet-evidence) |
| | Extra: spending controls · HCS audit log of spending · Mirror Node | per-chunk price cap, job budget, allowlist, kill switch · HCS receipt for every payment · payments re-checked on the mirror node |
| | Extra: agent identity (HCS-14) | [Agent identity (HCS-14)](#agent-identity-hcs-14) |
| **0G · Build with iAI** | Credits spent inside the app or by an agent, on 0G Private Computer | on 0G Private Computer: every provider does its work on 0G Compute ([src/provider/backend.ts](src/provider/backend.ts)); the verifier pays every canary's reference run on a different 0G model ([src/verifier/verifier.ts](src/verifier/verifier.ts)). A signed-in user's credits can pay for their own agent's calls |
| | A clear reason to come back and spend tomorrow's credits | [The verifier agent pays its own way](#the-verifier-agent-pays-its-own-way): credits buy checks that earn fees |
| | Users sign into their 0G account and their credit balance is read | [Sign in with 0G](#sign-in-with-0g): Privy → router session → balance; the user's credits can pay for their agent |
| | Contract deployment addresses | KINETIC's own contract is the bond vault on Hedera; on 0G it uses the ERC-8004 registries on Galileo (registrations and feedback transactions) and 0G Storage (model weights, and every Model and Compute Passport): [evidence/README.md § 3](evidence/README.md#3-0g-does-the-ai-work-and-the-checks) |
| **Arkiv · Build on Arkiv** | Writes to Arkiv's testnet with `@arkiv-network/sdk`, and users see data read from it | offers, claims, jobs, chunks, reputation; buyer discovery and the whole dashboard read them back |
| | Writer wallet addresses and one query | [evidence/README.md § 4](evidence/README.md#4-arkiv-holds-and-updates-the-marketplace) |
| | `arkiv/schema.md`, `friction.md`, `reach.md`, `why-arkiv.md`, `how-you-use-arkiv.md` | [arkiv/](arkiv/) |
| | Open-source license and how AI was used | [LICENSE](LICENSE), [How AI was used](#how-ai-was-used) |

## Known limits

- **The verifiers are run by one operator here.** Slashing needs 2 of 3 verifier signatures, and each cosigner re-checks the evidence with its own 0G runs before it signs, but on testnet all three keys belong to us. The guarantee is only as independent as the people holding the keys. The verifier set is fixed when the vault is deployed.
- **Disputes are decided by the same verifiers.** A disputed slash is re-checked by every verifier and needs all three (by default) to decide it, a higher bar than proposing it, and it is cancelled in the provider's favour if they don't. There is no outside arbitrator, and the provider can't submit its own counter-evidence: the verifiers re-run the checks instead.
- **Short dispute window.** `VAULT_DISPUTE_WINDOW` defaults to 60 s so a testnet job finishes in minutes. Real deployments want hours. A buyer's refund lands only when the slash executes; finalizing waits up to `SLASH_SETTLE_WAIT` for that.
- **Sequential workers:** each provider handles one chunk at a time, so no payment is in flight when a provider is slashed.
- **Known answers check one item per chunk, and only for the ten tasks with labelled examples.** A provider that answers planted items right but cuts corners on the rest is caught only by model canaries (which don't slash) or by its ranking. Other tasks rest on format and execution checks. Each set is small (24 to 36 items, split between planting and admission) and reused across jobs, so a provider that logs every text it sees could learn to spot repeats; a production verifier needs large, rotating sets.
- **Other signals are statistical.** Admission probes, model canaries and the model check sample a provider's behaviour; none proves which model ran. A canary compares the provider with a *different* 0G model, so it only fails the chunk. The model check catches a swap to a small model but not between similar large ones. The verdicts and evidence are public on HCS.
- **High assurance assumes independent providers.** Two copies agreeing proves little if one operator runs both; KINETIC keeps the copies on different providers but can't see who operates them.
- **Confidential means attested execution, not hidden data.** The KINETIC provider's process decrypts each chunk before sending it to 0G. No 0G route we tried returns a `tee_verified` verdict through the router; confidential jobs need providers that call one 0G Compute service directly, whose TEE signature the verifier checks.
- **No model hashes.** `authenticity.model.hash` is always `null`: neither 0G nor OpenAI-compatible servers publish one, and the passport doesn't invent it.
- **No delisting yet.** A listed model's status is only `reviewing`, `listed` or `refused`: a model that misbehaves on live jobs fails its chunks and its providers' checks, but isn't taken off the hub.
- **The provider sandbox is declared, not enforced.** `PROVIDER_SANDBOX` is a label in the provider's own offer; [docker/ollama-sandbox.compose.yml](docker/ollama-sandbox.compose.yml) is provided, but nothing checks that a provider uses it.
- **Revocation is for future chunks only.** A chunk key, once a provider has opened it, can't be taken back; nor can a sealed chunk it has received.
- **One operator runs every provider.** The two honest and three adversarial providers are separate accounts and nodes, but they're all run by us, on one machine, to show the checks working. The adversarial ones label themselves. Anyone can run a provider ([Run a provider of your own](#running-on-testnets)); none has yet.
- **Testnets only.** Nothing has run with real funds. Arkiv has no mainnet yet.
- **One x402 payment per recipient.** The verifier's fee is a separate payment from each chunk's: the x402 `exact` scheme on Hedera, as the public facilitator verifies it, rejects a payment that credits more than the one `payTo` (`invalid_exact_hedera_payload_extra_positive_transfers`), so a split payment would need a facilitator of our own.
- **0G sign-in needs 0G's Privy app id.** It's shared with teams at the event; the management-key path works without it.
- **0G trust verdict.** No 0G route we tried returns the router's own `tee_verified` verdict, TeeML included, so KINETIC doesn't rely on it. The verifier checks each canary's TEE signature itself against the signer in 0G's serving contract ([The verifier agent pays its own way](#the-verifier-agent-pays-its-own-way)). The router seals requests end to end (`X-0G-E2EE: sealed`), though, so the TEE signs hashes of the ciphertext. The signature proves the registered enclave served that exchange, but KINETIC can't bind it to the plaintext answer.

## How AI was used

KINETIC was designed and written with Claude Code (Anthropic) as a pair programmer. That covered architecture, code, tests and docs, with the team reviewing and directing the work.

## License

MIT, see [LICENSE](LICENSE).
