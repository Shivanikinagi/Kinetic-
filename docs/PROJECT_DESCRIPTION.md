# KINETIC

**Cheap community GPUs for AI, with every result checked and your money protected.**

## In one paragraph

KINETIC lets AI apps and agents run batch AI work, such as labelling, tagging and extraction, on cheap community GPUs without having to trust whoever runs them. Each job is split into small chunks, and each chunk is paid for separately over x402 on Hedera, only after its result comes back. Hidden questions with known answers are planted inside the work, so a provider that skips the work is caught. Its bond is then slashed by a quorum of verifiers, and the buyer is refunded automatically from that bond. Chunks from providers that fail or go offline move to others. Every job ends with a signed, public **Compute Passport** that anyone can check without trusting KINETIC. It runs live on Hedera testnet, 0G and Arkiv.

**Short version:** *Use community GPUs for AI without the risk: pay per chunk, every result checked, cheaters refund you automatically. Live on Hedera, 0G and Arkiv.*

---

## The problem

AI teams need a lot of inference for batch work: thousands of support tickets to label, documents to tag, fields to extract. Cloud GPUs are expensive. Community GPUs (gaming rigs, idle servers, small operators) are far cheaper, but using them means paying strangers:

- **Did they do the work?** A provider can return guessed or cached answers and still get paid.
- **Did they run the model they claim?** A cheaper, smaller model looks the same from outside.
- **What if they take the money and disappear?** Prepaying for a whole job puts all of it at risk.
- **Can you prove any of it later?** Usually there's no record of who did what or what was checked.

Today that leaves a choice between expensive and trusted or cheap and risky.

## The solution

KINETIC makes cheap compute safe to buy with four steps that run on every job:

1. **Split:** the job is cut into small, independent, encrypted chunks. Each chunk is paid for on its own, so the most a buyer can lose to one provider is a single chunk.
2. **Verify:** before any real work, every provider takes a short paid test with known answers, and providers that fail are never paid for job work. During the job, every chunk carries a hidden known answer. Some chunks are also secretly re-run on a different, verified 0G model for comparison.
3. **Enforce:** every provider has locked an HBAR bond in a smart contract. A provider that fails enough checks is slashed: 2 of 3 independent verifiers must re-check the evidence and sign. The buyer is refunded from the bond and the rest of the bond is burned.
4. **Recover:** chunks from cheating, failing or offline providers move to other providers automatically, so the job still finishes.

**You only pay for good work, and you can prove it.**

---

## How a job runs

1. **Ask.** The buyer starts a job from the dashboard, from the command line or from code.
2. **Lock in the rules.** The buyer agent splits the job into chunks, and encrypts each with its own key. It registers the job with the verifier, sending it the sealed chunks, and pays a small verification fee over x402. The job's rules are committed on Hedera HCS before any work starts: the share of chunks checked, the pass mark and a firm price quote. The verifier also commits, in secret, to which chunks it will check.
3. **Find providers.** The buyer discovers provider offers on Arkiv. Offers expire unless the provider keeps renewing them, so a dead node disappears on its own. It checks each provider's bond in the vault and its HCS-14 agent identity, then ranks the providers on price, track record and speed.
4. **Admit.** The verifier pays each provider for a probe chunk of known-answer items. The probe looks exactly like real work. Providers that answer wrong are rejected.
5. **Work and pay.** For each chunk, the buyer claims it on Arkiv and sends a paid x402 request on Hedera that carries the sealed chunk. The provider runs it on 0G Compute (or its own GPU), returns a signed result, and settles the payment only on success.
6. **Check.** The verifier checks the result's signature, the payment on the Hedera mirror node, the format and the planted known answer, and compares sampled chunks with a 0G reference run. Every check becomes an HCS receipt and updates the provider's reputation on Arkiv.
7. **Enforce and recover.** At the failure limit (3 of a provider's last 10 checks), the cosigning verifiers re-check the evidence independently, and 2 of 3 sign a slash in the bond vault. After a dispute window, the buyer is refunded and the rest of the bond is burned. The provider's chunks are redone elsewhere.
8. **Prove.** The verifier reveals its hidden check set on HCS. Then a Hedera PRNG seed, drawn only after the reveal, picks finished chunks to re-check on 0G, and the verifier anchors one Merkle root over the job's finished chunks on HCS (`hcs.merkleRootAnchor`). The buyer signs a **Compute Passport**, the verifier co-signs it only if it matches its own records, and the verifier stores it on 0G Storage.

---

## What makes it trustworthy

- **Ground truth decides slashing.** A provider is slashed only on hard evidence: wrong known answers, broken output, or false claims about how it ran. Disagreeing with another AI model only fails that chunk, because two good models can read an ambiguous item differently. A test proves the point: with the 0G reference model disagreeing with every honest answer, honest providers are never slashed and the lazy one still is.
- **Checks stay hidden.** Planted known answers sit at random positions under ids that look like the buyer's own. Probe chunks look exactly like real work, and the verifier commits to its canary set before any work starts. A provider can't tell which chunks are checked, and anyone can confirm the verifier didn't pick its canaries after seeing the results.
- **No single key can slash.** A slash needs signatures from 2 of 3 verifiers in the `KineticBondVault` contract. Each cosigner re-runs the failed checks itself before it signs. A slash can be disputed during a window, a larger quorum decides the dispute, and an undecided dispute goes in the provider's favour.
- **Payment safety:**
  - Providers settle each payment only after the chunk succeeds, so a crash is never charged.
  - A buyer never spends more at one provider than that provider's bond, so a refund is always covered.
  - If a provider takes a payment and then dies, the buyer finds that payment on the ledger and reports it, instead of losing track of it.
  - The firm quote, committed on HCS before work, is a hard spending ceiling.
- **A buyer can't fake a refund.** Results are signed by the provider. Refunds are sized from the transfers the Hedera mirror node shows, not from what the buyer claims.
- **Privacy:**
  - Each chunk is encrypted with its own key, and that key is wrapped so only the assigned provider can open it, for that job and chunk only.
  - Chunk data never goes on public Arkiv entities; it travels only inside the paid request.
  - A provider that is slashed, quarantined or goes offline never receives keys for later chunks.

## The Compute Passport

Every finished job produces a **Compute Passport** (`kinetic.passport.v2`): one public, signed JSON file on 0G Storage, addressed by its Merkle root and published with a JSON Schema so any application can check it without KINETIC's code.

- **Contents:**
  - For every chunk: which provider ran it, its signed result hash, its payment, and which checks it passed.
  - The hidden-check commitments and reveals, and the TEE signature check on each 0G reference run.
  - The job's HCS Merkle anchor (each chunk carries its proof) and the PRNG spot checks.
  - Every refund and slash, and the outcome of the job's agreement.
  - A list of what the passport does **not** prove.
- **Two questions kept apart:** *where and how it ran* (0G node, TEE guarantee) and *whether the answer was right* (ground truth, two providers agreeing, model agreement, or format only). An attested model can still give a wrong answer, and a correct answer doesn't prove which model produced it.
- **Signatures:** the buyer and the verifier both sign it. The verifier refuses to sign if anything differs from its own records.
- **Anyone can check it:** `npm run passport:verify -- <0G root>` checks the bytes against the root, the signatures, the reveals, the summary and the spending. Online, it also checks HCS, the mirror node and the vault. Editing any field breaks it.

---

## What you can use

- **Live dashboard:** every number comes from public sources (Arkiv, HCS through the mirror node, and the verifier's evidence). The header has two toggles, **Models** and **Console**.
  - **Models:** the model hub. Every listed model with its card, files, Model Passport (re-checked in the browser) and a **Try it** tab.
  - **Console → Overview:** network totals.
  - **Console → Run:** a form with a cost estimate and a **Stop all paid work** kill switch.
  - **Console → Jobs:** each job's chunks, checks, payments and receipts, with every transaction linked to HashScan.
  - **Console → GPUs:** each provider's bond, price, admission score, check record, latency, earnings and ERC-8004 reputation.
  - **Console → Publish, Creators and Earn:** publish a model, follow its royalties, or rent out a GPU.
  - **Console → Audit trail:** every HCS receipt. **Docs:** the commands to get started.
- **Command line:** `npm run kinetic -- init buyer` sets up a buyer in about five minutes: key, Hedera account, Arkiv gas and spending limits. Then use `run --task sentiment --items my.jsonl`, `run --model <id>`, `models`, `status` or `tasks`.
- **TypeScript SDK:** `new Kinetic({...}).run({ task, items })` returns results, what was paid and refunded, and the passport link. Also `providers()`, `halt()`/`resume()`, and `run({ model })`, `models()` and `publish()` for the model hub.
- **Run a provider:** `npm run kinetic -- init provider` detects your compute (0G or a local Ollama/vLLM server), sets up the account and bond, and `npm run kinetic -- provider` goes live.
- **Sign in with 0G:** a user's own 0G credits can pay for their agent's AI calls.

## More features

- **Ten tasks with known answers:** ticket classification, sentiment, language, news topic, spam, intent, animal class, ticket tags, ticket fields and invoice fields (252 labelled items). Each item was checked against both 0G models before use, so an honest provider is never slashed over a bad label.
- **Assurance tiers:** a buyer picks how much checking to pay for.
  - **Basic:** signed receipts and format checks only.
  - **Standard:** known answers in every chunk, plus hidden 0G checks.
  - **High:** two independent providers must agree on every chunk.
  - **Confidential:** only 0G Compute nodes whose TEE signs every response.
- **Smart provider choice:** providers are ranked on price, track record and speed (`cheapest`, `balanced` or `fastest`). Reserves step in when a provider is slashed or drops out.
- **Model check (fingerprinting):** borderline items that different models answer differently reveal whether a provider swapped in a smaller model. It is recorded as evidence and never used to slash.
- **Job agreement:** the buyer sets the share of chunks checked, the pass mark, its own labelled examples and a deadline, all committed on HCS before work.
- **Model hub:** creators publish open models (safetensors weights on 0G Storage) and earn a royalty on every accepted chunk. Three verifiers scan and benchmark each model and sign its Model Passport before it is listed. See [MODEL_HUB.md](MODEL_HUB.md).
- **Self-funding verifier:** the verifier spends daily 0G credits on checks and earns HBAR fees for them, a reason to come back and use each day's credits.

---

## Built with

| | How KINETIC uses it |
|---|---|
| **Hedera** | x402 payments in HBAR (per chunk, listing fees, royalties) through public facilitators, with failover between x402.org, Blocky402 and Launa. `KineticBondVault` on Hedera EVM holds bonds and handles quorum slashing, disputes, refunds and burns, and executes a slash itself when its dispute window closes (HIP-1215 scheduled call). Its Hedera PRNG seed picks the post-job spot checks. HCS is the audit log for every payment, check, slash and reveal, plus one Merkle anchor per job. The mirror node re-checks payments. Every agent has an HCS-14 identity. |
| **0G** | Providers do their work on 0G Compute (`0gm-1.0-35b-a3b`, TeeML). The verifier checks them against a different 0G model (`glm-5.3`, TeeML; canaries run in 0G's `private` trust mode), paid from its 0G credits, and verifies each enclave's signature itself. 0G Storage holds multi-GB model weights and every Model and Compute Passport. ERC-8004 on 0G Chain gives every GPU and the verifier an agent identity and each GPU its measured reputation. Users can sign in with 0G and pay with their own credits. |
| **Arkiv** | Expiring provider offers, chunk claims with leases, job and chunk state, reputation, model listings, and one expiring, readonly entity per check. Buyers find providers by query, and the dashboard reads from Arkiv, with changes pushed through the verifier's stream of Arkiv entity events. |

**Tech:** TypeScript and Node.js (agents, providers, verifiers, CLI, SDK), Solidity (bond vault), React and Vite (dashboard), Vitest (206 tests on a local emulator of all three networks, plus the vault contract in an in-process EVM). MIT licensed.

---

## Proof it works: live on testnet

The demo video records a real job: `job-mvxlhphr-e357a5`, which labelled 60 tickets in 20 chunks on Hedera testnet.

| Provider | What happened |
|---|---|
| **BudgetGPU** | Matched 0% of known answers on the entry test. Rejected and never paid for job work. |
| **QuickCompute** | Passed the entry test, then cut corners on real work. Missed known answers, so 2 of 3 verifiers signed a slash. Buyer refunded **0.003 ℏ** from its bond; the rest of the bond was burned. |
| **EdgeRelay** | Went offline partway through. Its unfinished work moved to another provider. The one payment it kept without delivering was found on the ledger. |
| **BluePeak, Riverstone** | Honest. Did the work, passed every check and were paid. |

Result: **20/20 chunks**, agreement met, 0.0252 ℏ paid to providers, 0.003 ℏ refunded, within the firm quote.

- Chunk payment on HashScan: [0.0.9185802-1793523703-790308673](https://hashscan.io/testnet/transaction/0.0.9185802-1793523703-790308673)
- Slash proposed (3 signatures): [0xd4101e26…2798](https://hashscan.io/testnet/transaction/0xd4101e264b910d5e2e08229f710b240b9d837edf0cc3ce197761cafff2f72798)
- Slash executed, refund to the buyer: [0xcc1989d4…1f3f](https://hashscan.io/testnet/transaction/0xcc1989d4ab3032c631c273b0783625327b01cadbad3c71c2f6a2e1b6194e1f3f)
- HCS audit topic: [0.0.11212792](https://hashscan.io/testnet/topic/0.0.11212792)
- Bond vault (2 of 3 verifiers to slash): [0x11d7…b294](https://hashscan.io/testnet/contract/0x11d76cec886b06d5f8e7f4e7d9a5fa2c9808b294)

Earlier runs in the README cover all ten tasks (every job completed, no honest provider slashed), and a high-assurance job where two providers agreed on every chunk. Real network failures were handled along the way: the public x402 facilitator returned errors (those chunks were never charged and were rerouted), and a 0G call failed during an admission probe.

---

## Try it

```bash
npm install
npm run kinetic -- init buyer      # your key, Hedera account, Arkiv gas, spending limits
npm run kinetic -- run --task sentiment
```

Or run the whole network yourself: `npm run setup:testnet`, `npm run live -- --serve`, `npm run web`, then open http://localhost:5173.

Guides: [USE_KINETIC.md](USE_KINETIC.md) (buyers), [RUN_A_PROVIDER.md](RUN_A_PROVIDER.md) (providers), [MODEL_HUB.md](MODEL_HUB.md) (creators), [README](../README.md) (architecture and evidence).

## Known limits

- **One operator for now.** On testnet, the three verifier keys and all five providers (two honest, three deliberately adversarial test providers that label themselves) are run by the team. That shows the checks working, but the guarantees are only as independent as whoever holds the keys. Anyone can run a provider, but no outside provider has joined yet.
- **Statistical checks.** Known answers check one item per chunk, and only for tasks with labelled examples. Model comparison and fingerprinting are evidence, not proof of which model ran.
- **Testnets only.** Nothing has run with real funds, and Arkiv has no mainnet yet. The 60-second dispute window suits demos; real use needs hours.

## What's next

Independent verifier operators and outside providers, larger rotating sets of known answers, longer dispute windows, publishing the SDK to npm, and mainnet once Arkiv launches.

## Links

- Demo video: *(add link)*
- Live demo: *(add link)*
- Repository: *(add link)*
- Team: *(add names, Telegram and X)*
