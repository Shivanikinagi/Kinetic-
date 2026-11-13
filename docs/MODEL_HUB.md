# The KINETIC model hub

Creators publish open models and earn a royalty on every job that uses them. Buyers and agents run a listed model on community GPUs with one call. Every check that protects a plain KINETIC job still applies: admission probes, hidden known answers, 0G canaries, quorum slashing, refunds and the Compute Passport.

```
creator ──signed card + weights──▶ 0G Storage
   │                                  │
   └──x402 listing fee──▶ verifier ──┤ review: malware checks · benchmark · fingerprint
                            │        │
              cosigners ◀───┘ each re-reviews on its own and signs
                            │
              Model Passport ──▶ 0G Storage (public) · digest ──▶ HCS · listing ──▶ Arkiv
                                                                   │
provider ──reads listing, checks passport + weights──▶ serves it ──┘ (offer: model.<key>)
                                                                   │
buyer ──Run via KINETIC──▶ job on that model ──▶ chunks signed for the model
                                   └──x402 royalty on accepted chunks──▶ creator
```

## 1. Publish a model

A **model card** names the model and its version, the task it does (labels or fields), what providers run (`0g` for a model served by 0G Compute, `openai` for a model providers run on their own GPU from its weights), the licence and the creator's royalty (0–30% of provider payments, in basis points). The creator signs it, so nobody else can list a model in their name or redirect its royalties, and the terms are fixed per version.

```bash
npm run kinetic -- models publish --card my-model.card.json --weights ./my-model/   # a model providers run themselves
npm run kinetic -- models publish --card data/models/ticket-classifier.card.json      # a model served by 0G
```

From code:

```ts
await kinetic.publish({ card, files: [{ name: "model.safetensors", bytes }, { name: "config.json", bytes }] });
// Large weights: give paths, and nothing is read into memory.
await kinetic.publish({ card, files: [{ name: "model.safetensors", path: "./qwen/model.safetensors" }, { name: "config.json", path: "./qwen/config.json" }] });
```

The malware checks run on the creator's machine first, so a bad file never leaves it. Then the weights are uploaded, and the card lists each file's sha256 and where it is:

- **0G Storage** (default): built for large files, so multi-GB weights fit. Each file is addressed by its Merkle root (`zgRoot`). The creator's 0G wallet pays 0G's storage fee (about 0.13 0G per GB on Galileo testnet). Downloads need no wallet, and every party recomputes the root from the bytes it receives, because the SDK's own proof flag doesn't verify yet.
- **A source URL** (`weightsSource` in the card): for weights hosted elsewhere, still checked against the signed sha256.

Weights stream through disk everywhere, so multi-GB models need disk, not memory: the creator's malware checks hash each file as a stream and read only safetensors headers and small config files; the upload goes from the file; verifiers download each file straight to a temporary folder (0G Storage segments are fetched in parallel and written at their offsets), check its sha256 and Merkle root from the file, scan it the same way and delete it; providers keep the checked files in `.kinetic/models/<key>/` and re-check a cached file's sha256 before reusing it.

Then the creator pays the verifier's listing fee over x402. A card that is incomplete, not signed by its creator, or already listed is refused before any payment. The fee pays for the review itself (every verifier's benchmark and fingerprint runs), so it settles when the review starts, and a model the review refuses still used those runs. The review runs in the background, minutes on real networks; the publish command waits for it (`GET /models/reviews/:key`).

## 2. How a model is reviewed

The verifier reviews the model itself, then asks the bond vault's other verifiers to do the same on their own: their own downloads, their own model runs, their own labelled sets. Each signs only if it reaches the same answers. The passport needs as many signatures as the vault needs to slash.

| Check | What it does | What it can't do |
|---|---|---|
| **Malware checks** ([src/models/safetensors.ts](../src/models/safetensors.ts)) | Weights must be safetensors: a JSON header plus raw tensor bytes, which can't run code when loaded. Pickle formats (`.bin`, `.pt`, `.pkl`, …), code and binaries are refused, and so is custom model code in configs (`auto_map`, `trust_remote_code`). Every header is parsed: known dtypes, sizes that match shapes, and tensors that tile the data exactly, with no gaps, overlaps or trailing bytes, so nothing can hide in a file that passes. | Detect a backdoor trained into the weights: that's a property of the numbers. The benchmark, fingerprint and per-job checks cover behaviour. |
| **Benchmark** | 12 labelled examples (by default) from the verifiers' own set, which the creator never sees, run on the model. The bar to list is 70% (`MODEL_MIN_ACCURACY`). Tasks the verifiers have no examples for need at least 8 labelled examples from the creator, and the passport says so. | Measure safety. It measures accuracy on the task. |
| **Fingerprint** | The model's answers on borderline inputs where different models answer differently. Providers serving the model are later probed with these, so a provider swapping in a cheaper model shows up. | Prove which model ran: it is statistical evidence, recorded at every admission and never a slash on its own. |
| **Quorum** | Every verifier re-runs the review and signs the passport digest. | |

The **Model Passport** ([src/models/passport.ts](../src/models/passport.ts)) holds the card, the creator's signature, the malware report (each file's sha256, parameter count and dtypes), the benchmark, the fingerprint, the verifiers' signatures and its own limitations. The listing verifier stores it on 0G Storage unencrypted (the listing's `passportRef` is its 0G Merkle root), its digest goes to HCS (a `model` receipt), and a `model` listing to Arkiv. New passports name the 0G Storage indexer in `references.storageGateway`; passports issued before 2026-11-11 keep a legacy `references.swarmGateway` field because it is inside the signed body. Only listings written by a vault verifier are trusted. Listings expire like any Arkiv entity, so the verifier renews them daily and re-creates any that lapse from its record; the passport on 0G Storage and its digest on HCS don't expire with them.

```bash
npm run kinetic -- models              # every listed model
npm run kinetic -- models show kinetic/ticket-classifier   # its card, passport and every check on it
```

## 3. Serve a model (providers)

```bash
PROVIDER_MODELS=kinetic/ticket-classifier npm run provider             # with a hand-written .env
PROVIDER_MODELS=kinetic/ticket-classifier npm run kinetic -- provider  # after npm run kinetic -- init provider
```

Before a provider offers a model it reads the listing, downloads the Model Passport and checks it (creator signature, malware report, benchmark, quorum), downloads the weights, checks every file against the passport's sha256, and runs the malware checks again on the exact bytes it will load. A model that fails any of these isn't served. The offer then carries `model.<key>` on Arkiv, so buyers find it by query. A provider refuses a chunk for a model it doesn't serve before any payment.

To run a self-hosted model in a sandbox, use [docker/ollama-sandbox.compose.yml](../docker/ollama-sandbox.compose.yml): Ollama on an internal network with no route out and read-only access to the checked weights, and the provider node as the only bridge. Declare it with `PROVIDER_SANDBOX=docker:no-network`. That is a declaration in the offer, not something KINETIC can prove.

## 4. Run a model (buyers and agents)

```bash
npm run kinetic -- run --model kinetic/ticket-classifier --items my-tickets.jsonl
```

```ts
const report = await kinetic.run({ model: "kinetic/ticket-classifier", items: tickets, budget: "0.5 HBAR" });
```

In the dashboard, every model on the **Models** page has a **Run** button, which opens Console → Run with the model chosen (`#/run/<key>`, button **Run via KINETIC**). A model's own page also has a **Try it** tab that runs a few lines as a real job (**Run on KINETIC**).

A model job is a normal KINETIC job with four additions:

1. **Only providers serving the model** are discovered, and each is admitted with probes run on that model, including the model's fingerprint.
2. **The model's terms are in the agreement** (model key, passport digest, royalty, creator account), so they are committed on HCS before any work, with the rest of the rules. The firm quote includes the most the royalty can be.
3. **Every chunk is signed for the model.** The provider's result signature covers the model key; a result signed for another model is rejected.
4. **The creator is paid after the job.** The verifier computes the royalty from the chunks it accepted as final, and the buyer pays it over x402 straight to the creator's account. Refunded, rerouted and failed chunks are never in it: a slashed provider's work earns the creator nothing. The payment gets an HCS `royalty` receipt.

The **Compute Passport** gains a `model` section (the model, its passport, the royalty and its transaction), and `npm run passport:verify` checks that the terms match the agreement committed before work, that the royalty is exactly the agreed share of the accepted chunks, that it reached the creator on the ledger, that the HCS receipts match, and that the Model Passport on 0G Storage is the one the job ran against.

## Settings

| Variable | Default | Role |
|---|---|---|
| `MODEL_MIN_ACCURACY` | `0.7` | verifier: benchmark needed to list |
| `MODEL_BENCHMARK_ITEMS` | `12` | verifier: labelled examples per benchmark |
| `MODEL_LISTING_FEE_TINYBAR` | `1000000` (0.01 ℏ) | verifier: x402 listing fee |
| `MODEL_MAX_DOWNLOAD_MB` | `512` | verifier: largest weights it downloads to check (the testnet verifiers use `4096` for self-hosted models) |
| `VERIFIER_MODEL_URL` | `http://localhost:11434/v1` | verifier: where it runs self-hosted models it reviews |
| `ZG_STORAGE_RPC_URL` | `https://evmrpc-testnet.0g.ai` | 0G chain (Galileo, 16602) the storage fee is paid on |
| `ZG_STORAGE_INDEXER_URL` | `https://indexer-storage-testnet-turbo.0g.ai` | 0G Storage indexer |
| `PROVIDER_MODELS` | | provider: models to serve |
| `PROVIDER_MODEL_IMPORT` | | provider: `ollama` imports checked weights into the local Ollama |
| `PROVIDER_SANDBOX` | | provider: how it isolates the runtime, declared in its offer |

## Limits

- The review rests on the verifiers' own runs. A self-hosted model needs each verifier to run it (`VERIFIER_MODEL_URL`), and large weights need the download budget to match.
- 0G Storage stores one root per file up to 4 GiB; shard larger weights (safetensors models usually are). Uploads need 0G for the storage fee (the creator pays for weights, the listing verifier for passports); the testnet faucet gives 0.1 0G a day.
- Arkiv bills reads. An access key (`ARKIV_API_KEY`) has a quota; without one, or once it's used up, an IP gets about 100 queries per window. Every listing, offer and dashboard view is an Arkiv read, so a live network needs a key with quota to spare. When a quota runs out, KINETIC reads without the key and fails fast rather than waiting out Arkiv's Retry-After.
- Royalties are paid by the buyer after the job. The verifier won't co-sign the Compute Passport of a job whose royalty is unpaid, so the buyer has no verifier-attested proof of the job without paying; nothing on-chain forces the payment beyond that.
