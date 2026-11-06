# KINETIC demo script (about 4 minutes)

Everything in this demo is live on Hedera testnet, 0G, Arkiv and Swarm. Nothing is mocked; every step ends in something a judge can click and check.

## Before you present

- `npm run live -- --serve` and `npm run web`, then open http://localhost:5173. Wait for "ready" in the terminal.
- Keep the laptop plugged in and awake.
- Arkiv: an access key with quota in `ARKIV_API_KEY` (Rabdi), so the dashboard reads aren't throttled.
- Have one slashed job in the history (any run of `npm run live` with the adversarial providers makes one) and note its id.
- Close other dashboard tabs: each one polls Arkiv.

## The flow

The publish step takes 2–4 minutes, so it starts early and finishes while you show the rest.

The site header has two toggles: **Models** (the hub, `#/models`) and **Console**. Publish, Jobs, GPUs, Creators and Docs are in the Console's activity bar.

| Time | Screen | What to do | What to say |
|---|---|---|---|
| 0:00 | Home | Point at the headline, then scroll to *How it works*. Click **Open the console**. | "Model hubs host files nobody checks, and AI marketplaces trust whoever runs the GPU. KINETIC is a model hub where every model is verified by a quorum and every result is checked, and a GPU that cheats pays for it." |
| 0:20 | Console → **Publish** | Pick *Review sentiment*, call it `yourname/sentiment-pro`, set a 5% royalty, click **Publish model**. | "I'm publishing a model. Three independent verifiers will benchmark it on examples I never see, and each one signs its passport only if it gets the same answers." Let the stepper run; don't wait for it. |
| 0:45 | **Models** (header) | Open `kinetic/qwen2.5-1.5b-invoice-extractor`. Show the chips, then the **Files** tab. | "This one runs on community GPUs: real Qwen 1.5B weights, 3 GB, stored on 0G Storage. Every file is addressed by its Merkle root." |
| 1:05 | Model, **Passport** tab | Scroll the checks. | "Your browser just re-checked this passport: the creator's signature, the malware scan, the benchmark and three verifier signatures. No server to trust." |
| 1:25 | Model, **Try it** tab | Keep the sample invoices, click **Run on KINETIC**. | "Now a real job. Each chunk is paid in HBAR over x402, and every chunk hides a question with a known answer." Narrate the stepper: GPU admitted, rules committed on Hedera, paid, checked, settled, creator paid. |
| 2:10 | Try it result | Show the outputs, click **Job & Compute Passport**. | "Every output, what I paid, and a Compute Passport anyone can verify. The model's creator just earned a royalty, on accepted chunks only." On the **Checks** tab: "Each hidden check ran on 0G inside a TEE (private mode), and we verified the enclave's signature ourselves." Then the side panel's *Merkle anchor* and *PRNG spot checks*: "The whole job is one Merkle root anchored on Hedera, and after it closed Hedera's PRNG picked a random chunk to re-check." |
| 2:30 | **Jobs**, the slashed job | Open its **Checks** tab. | "This GPU stopped calling its model to save money. The hidden checks caught it, two of three verifiers co-signed, and after the 60-second dispute window the vault executed the slash itself: Hedera ran its own scheduled call (HIP-1215), no keeper. The buyer was refunded. Here's the transaction on HashScan." |
| 3:00 | **Publish** (back) | It should read *Your model is live*. Click **View model & try it**, then the **Passport** tab. | "And my model is listed: benchmarked, signed by three verifiers, its receipt on Hedera. Its passport is on Swarm behind a signed feed: this *Latest passport* link never changes and always points to the newest version." |
| 3:10 | **GPUs** | Open a GPU row: its ERC-8004 pill and *On-chain reputation*. | "Every GPU is a public ERC-8004 agent on 0G Chain. After each job the verifier writes its measured score there, so its reputation follows it to any app, not just ours." |
| 3:20 | **Creators** | Show royalties and a payment link. | "Creators earn on every job, straight to their Hedera account. Every number on this page is on-chain." |
| 3:40 | **Docs** | Scroll the four steps. | "One command to start: run a model, publish one, or rent out a GPU." |

## What each sponsor does here

- **Hedera:** x402 payments in HBAR (per chunk, listing fees, royalties) with three facilitators for failover, HCS receipts for every check, one Merkle anchor per job, PRNG spot checks after a job closes, and the bond vault that slashes, refunds and executes its own slashes (HIP-1215 scheduled calls).
- **0G:** Compute runs the hidden canaries in `private` mode (TeeML only), and the verifier checks each enclave signature against 0G's on-chain registry; it also serves models; Storage holds multi-GB model weights; ERC-8004 on 0G Chain gives every GPU and the verifier a public agent identity, and each GPU's measured reputation (the verifier's feedback after every job) is on-chain.
- **Arkiv:** offers, jobs, chunks, reputations and model listings, with expiry; named schemas with typed columns, readonly check results, trust by creator, and live events pushed to the dashboard (about 90% fewer metered reads than polling).
- **Swarm:** sealed job chunks, the Model and Compute Passports with erasure coding, and a signed feed per model for a stable "latest passport" URL.

## If something goes wrong

- **Publish refused:** that's the system working. Open the reason ("benchmark below 70%") and say so; then show a listed model instead.
- **Try it shows "Job incomplete":** a hidden check failed and the chunk was refused. Show the Checks tab: that's the demo.
- **"Some data is delayed" in the top bar:** Arkiv is throttling reads. Everything still works; numbers catch up within a minute.
