# KINETIC live run job-mw3qzkrd-585265

16/16 chunks · providers paid 0.0212 ℏ · refunded 0.003 ℏ · verifier fee 0.0016 ℏ · net 0.0198 ℏ
- Agreed before work (hash in the HCS job receipt): standard assurance: known answers in every chunk and hidden 0G canaries; check at least 25% of chunks against 0G; a checked chunk passes at 80% agreement; admit providers that score 80% on the verifier's labelled examples; pay at most 0.0256 ℏ, quoted from live offers: 16 chunks + 4 for reroutes at up to 0.0012 ℏ each, plus the verifier's 0.0016 ℏ fee
- Agreement met: all 16 chunks finished within the budget; paid 0.0228 ℏ of the 0.0256 ℏ quoted

## Hedera
- HCS receipts topic: https://hashscan.io/testnet/topic/0.0.11212792
- Bond vault: https://hashscan.io/testnet/contract/0x585054f20af2c3023156c10a3ee4bdeed90bb48a
- x402 verification fee (buyer → verifier): https://hashscan.io/testnet/transaction/0.0.9185802-1793895386-914544162
- x402 chunk payment #7: https://hashscan.io/testnet/transaction/0.0.9185802-1793895687-171321507
- x402 chunk payment #3: https://hashscan.io/testnet/transaction/0.0.9185802-1793895665-344368387
- x402 chunk payment #12: https://hashscan.io/testnet/transaction/0.0.9185802-1793895664-362573428
- x402 chunk payment #10: https://hashscan.io/testnet/transaction/0.0.9185802-1793895637-130373748
- x402 chunk payment #4: https://hashscan.io/testnet/transaction/0.0.9185802-1793895629-657298266
- Slash + refund (QuickCompute): https://hashscan.io/testnet/transaction/0xa1026d293e6cb21fe302fc0fa6f2661326191397bf547a41b0a244013a18bdaf

## 0G Private Computer (verified reference runs)
- canary #11: PASS agreement 1, request id `b60f4dd1-ad75-4891-af93-b4716734d053`
- canary #5: PASS agreement 1, request id `0cd4bf9e-bb0d-46af-8ed0-bcaa6c3f8e28`
- canary #0: PASS agreement 1, request id `fe69da5e-29d3-42b8-b7a4-32c34b91cf20`
- canary #1: PASS agreement 1, request id `33ef19e7-209e-4311-8771-d57d1ba72076`

## Arkiv (chain 7794095)
- buyer (jobs, chunks, claims): https://rabdi.explorer.arkiv.network/address/0x8ed8a58f08a2caa800cbb4083e3691e5ca1e73a6
- verifier (reputation): https://rabdi.explorer.arkiv.network/address/0xa19cc96ea9f0e414cebb149918e4c5549554adc8
- BluePeak (offer): https://rabdi.explorer.arkiv.network/address/0x7db49eb7d37ba00de37518f26b704c57ebecf5ab
- Riverstone (offer): https://rabdi.explorer.arkiv.network/address/0x2d3a9cdf8fc2512c71d8393dbf2e2f2c1209fcda
- QuickCompute (offer): https://rabdi.explorer.arkiv.network/address/0xae37efe9cbb3a742d7f61b21dd58dec2013f78b2
- EdgeRelay (offer): https://rabdi.explorer.arkiv.network/address/0xd943e795047d6f8796da522426ec42d84541dccd
- BudgetGPU (offer): https://rabdi.explorer.arkiv.network/address/0xded1726fb7db5019c791b65ba3a8ac8788f99208
- Query: `arkiv.schema = str('kinetic.job') AND app = str('kinetic') AND job_id = str('job-mw3qzkrd-585265')`

## Swarm
- Compute Passport (co-signed by the verifier): https://api.gateway.ethswarm.org/bytes/84964866a8c2e58b8e086134a0ba2d3f9143af0ab180a8ae74d5a2f3e89eb58d
- Check it: `npm run passport:verify -- 84964866a8c2e58b8e086134a0ba2d3f9143af0ab180a8ae74d5a2f3e89eb58d --results evidence/2026-11-05-job-mw3qzkrd-585265/results.json`
