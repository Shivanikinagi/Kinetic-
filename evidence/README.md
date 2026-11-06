# KINETIC: evidence you can check yourself

Everything below ran on public testnets on 2026-11-05. Each claim links to a record you can open without trusting us. The full run is in [2026-11-05-job-mw3qzkrd-585265/](2026-11-05-job-mw3qzkrd-585265/): its evidence file, the buyer's results, the Compute Passport, and the output of `passport:verify` (every check passed).

## The deployment

| What | Where |
|---|---|
| Bond vault (Hedera testnet EVM) | [`0x5850…b48a`](https://hashscan.io/testnet/contract/0x585054f20af2c3023156c10a3ee4bdeed90bb48a), source [verified on Sourcify](https://repo.sourcify.dev/296/0x585054f20af2c3023156c10a3ee4bdeed90bb48a) (exact match) |
| Audit log (Hedera HCS) | topic [`0.0.11212792`](https://hashscan.io/testnet/topic/0.0.11212792); only the verifier can write to it |
| Marketplace state (Arkiv) | Rabdi testnet, chain 7794095 |
| AI work and checks (0G) | 0G router (TeeML providers), ERC-8004 registries on 0G Galileo |
| Files (Swarm) | public gateway `api.gateway.ethswarm.org` (see the caveat in 5) |

## 1. Money moves through Hedera

The buyer paid each chunk separately over x402, in HBAR, settled by a public facilitator: 0.0212 ℏ to providers and a 0.0016 ℏ verifier fee.

- Verifier fee: [0.0.9185802-1793895386-914544162](https://hashscan.io/testnet/transaction/0.0.9185802-1793895386-914544162)
- Chunk payments, for example #3 [0.0.9185802-1793895665-344368387](https://hashscan.io/testnet/transaction/0.0.9185802-1793895665-344368387) and #7 [0.0.9185802-1793895687-171321507](https://hashscan.io/testnet/transaction/0.0.9185802-1793895687-171321507). Every payment is listed in [the evidence file](2026-11-05-job-mw3qzkrd-585265/evidence.md).

## 2. Dishonest providers get penalized

QuickCompute is a test provider that cheats on purpose. It passed admission, then stopped calling its model, and missed the hidden known answers planted in its chunks.

1. Both cosigning verifiers re-checked the evidence and signed. The slash was proposed with 3 of 3 signatures: [0x3220…f8](https://hashscan.io/testnet/transaction/0x322073a9f5ee206a5109bb7a42041aaaf775f50e0503db9d9b9964835a9da2f8) (HCS receipt #1442).
2. The proposal paid the vault to settle the slash itself. The vault booked schedule [`0.0.11326834`](https://hashscan.io/testnet/schedule/0.0.11326834) (HIP-1215) for 16:21:01 UTC, just after the 60 s dispute window.
3. The schedule ran on time and executed the slash: [0xa102…af](https://hashscan.io/testnet/transaction/0xa1026d293e6cb21fe302fc0fa6f2661326191397bf547a41b0a244013a18bdaf), a scheduled transaction. The buyer was refunded **0.003 ℏ** from the bond and the remaining **0.997 ℏ was burned** (HCS receipt #1451, `scheduled: true`).
4. The slash is also on QuickCompute's ERC-8004 record on 0G: [0x488d…6a](https://chainscan-galileo.0g.ai/tx/0x488d0fb96c9e207ab6b8ac9961e2c6b67d905c2cd9033b8dfe69c920dfa8f36a).

In the same job, BudgetGPU (never calls a model) was rejected at admission and never paid, and EdgeRelay (goes offline while holding a payment) was routed around; the payment it kept is reported.

## 3. 0G does the AI work and the checks

- **Work:** every provider ran `0gm-1.0-35b-a3b` on 0G Compute.
- **Checks:** 4 hidden canary chunks were re-run on 0G's `glm-5.3` in TeeML-only mode and agreed 100%. Request ids: `b60f4dd1-ad75-4891-af93-b4716734d053`, `0cd4bf9e-bb0d-46af-8ed0-bcaa6c3f8e28`, `fe69da5e-29d3-42b8-b7a4-32c34b91cf20`, `33ef19e7-209e-4311-8771-d57d1ba72076`.
- **TEE signatures, checked by us:** for each canary the verifier fetched the 0G provider's TEE signature and checked it against the signer registered in 0G's serving contract on 0G mainnet (`0xb280…8eb7`), not the router's word. `passport:verify` re-checks all 4.
- **After the job:** a Hedera PRNG seed ([0x4957…64](https://hashscan.io/testnet/transaction/0x49570ff2b757f20def80dbf5d15b0ba31a3a802b498c20aa198e908742c21464)), drawn only after the canaries were revealed, picked chunk 14 for an extra 0G re-check, which agreed.
- **Agent identities and reputation (ERC-8004 on 0G Galileo):** the verifier is agent 567 ([registration](https://chainscan-galileo.0g.ai/tx/0xd9f8fb155074a3e8e52f46b2e342eec8f77fac087c71de226230361a3d31ebc3)). After the job it posted each GPU's share of hidden checks passed: BluePeak 100% ([tx](https://chainscan-galileo.0g.ai/tx/0x5b1795ab04b9ca8df2a88f05f8b09fd774ebe0dde90aaee5ed3f316b5ffcf777)), Riverstone 100% ([tx](https://chainscan-galileo.0g.ai/tx/0x71e5626c049681c945dcc6516153a06475a92ed732d27ccea32586b35a55c9e4)), EdgeRelay 100% ([tx](https://chainscan-galileo.0g.ai/tx/0x947e59d07d57905c0adb04c2baba4f815b729f5264c0da807bc3c17925828c67)), QuickCompute 40% ([tx](https://chainscan-galileo.0g.ai/tx/0x324f9c7966ecda14b58b4cbfc896f25c06f5ba23af8698c0ec8b38bc827409ca)).
- **Model weights on 0G Storage:** `kinetic/qwen2.5-1.5b-invoice-extractor` keeps its 2.88 GB weights on 0G Storage, submission [158079](https://storagescan-galileo.0g.ai/submission/158079).

What this does not show: the providers' own work carries no TEE attestation in this run (the passport marks those chunks unattested). Only the verifier's canary reference runs are TEE-checked.

## 4. Arkiv holds and updates the marketplace

Provider offers (which expire unless renewed), chunk claims (2-minute leases), job and chunk progress, per-check records and reputation are Arkiv entities, written by the wallet that owns them.

- Writers: the buyer [`0x8ed8…73a6`](https://rabdi.explorer.arkiv.network/address/0x8ed8a58f08a2caa800cbb4083e3691e5ca1e73a6) (jobs, chunks, claims), the verifier [`0xa19c…adc8`](https://rabdi.explorer.arkiv.network/address/0xa19cc96ea9f0e414cebb149918e4c5549554adc8) (checks, reputation, model listings), and each provider (its offer), all listed in [the evidence file](2026-11-05-job-mw3qzkrd-585265/evidence.md).
- One query, for this job's entity:

  ```
  arkiv.schema = str('kinetic.job') AND app = str('kinetic') AND job_id = str('job-mw3qzkrd-585265')
  ```

  Its `audit_ref` attribute is the Swarm reference of the Compute Passport below.

## 5. Swarm stores the files

- The Compute Passport: [`84964866…b58d`](https://api.gateway.ethswarm.org/bytes/84964866a8c2e58b8e086134a0ba2d3f9143af0ab180a8ae74d5a2f3e89eb58d). `passport:verify` downloads it chunk by chunk and checks every chunk against its content address, so a gateway can't alter it.
- The job's 16 input chunks and their results are on Swarm too, sealed with AES-GCM; their references are encrypted on Arkiv, by design.

**Caveat:** these uploads are stamped by the public gateway, which keeps them only for a while. A postage batch of our own is being bought on Gnosis Chain. Until that's done, a copy of the passport is in this folder, and its hash still matches the reference.

## 6. Anyone can run a provider

[docs/RUN_A_PROVIDER.md](../docs/RUN_A_PROVIDER.md) explains how to join with your own key: bond HBAR in the vault, publish an Arkiv offer, and serve chunks on 0G Compute or your own GPU. Buyers find offers on Arkiv and check bonds in the vault; there is no allowlist unless a buyer sets one.

To be clear: every provider in this run, honest and adversarial, was run by our team, and the three verifier keys are ours too. No outside provider has joined yet.

## Check it yourself

```bash
npm install
npm run passport:verify -- 84964866a8c2e58b8e086134a0ba2d3f9143af0ab180a8ae74d5a2f3e89eb58d \
  --results evidence/2026-11-05-job-mw3qzkrd-585265/results.json
```

This checks the signatures, the canary and known-answer commitments, each chunk's Merkle proof under the anchor on HCS (receipt #1460), the PRNG draw, every payment on the mirror node, the slash in the vault, and the canaries' TEE signatures. It needs no keys.
