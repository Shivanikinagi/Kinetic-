# A postage batch for KINETIC's Swarm uploads

Without a postage batch, KINETIC uploads through the public gateway (`https://api.gateway.ethswarm.org`) and the gateway pays for storage with its own batch. That storage is free but short-lived: an older audit bundle from a live run is already unreachable. Passports should outlive that, so this page covers how to pay for storage ourselves, what it costs, and what the gateway accepts.

## What the public gateway accepts (tested live, 2026-11-03)

| Request | Result |
|---|---|
| `POST /bytes`, no headers | 201, 64-hex reference |
| `POST /bytes` with `swarm-redundancy-level: 1`, `2` or `4` | 201. The reference downloads and passes the chunk-by-chunk BMT check |
| `POST /bytes` with `swarm-postage-batch-id: <random batch>` | 201. **The header is ignored**: the gateway stamps with its own batch. A batch id only works on the Bee node that owns the batch |
| `POST /bytes` with `swarm-postage-stamp` | 400 `swarm-postage-batch-id … required`. Pre-signed stamps are not supported on `/bytes` |
| `POST /chunks` with a bee-js `Stamper` stamp, or KINETIC's own, on a batch that isn't on chain | 400 `invalid batch id`. **The stamp is forwarded** and Bee checks it against the chain |
| `POST /soc/{owner}/{id}?sig=…`, no batch | 201. Single-owner chunks and feed updates are accepted and stamped by the gateway |
| `POST /soc` with our stamp, on a batch that isn't on chain | 400 `invalid batch id` (forwarded, as with `/chunks`) |
| `POST /feeds/{owner}/{topic}`, no batch | 201. A feed manifest; the same owner and topic always give the same reference |
| `GET /feeds/{owner}/{topic}` | 200, the newest update resolved (`swarm-feed-index`, `swarm-feed-index-next`, `swarm-soc-signature`). The newest index lags a few seconds after a write |
| `GET /bzz/{feed manifest}/` | Serves what the newest update points at, if the update points at a manifest (a `/bzz` upload). A raw `/bytes` reference gives 404 |
| CORS | `GET` from any origin. `Swarm-Feed-Index`, `Swarm-Feed-Index-Next` and `Swarm-Soc-Signature` are exposed. A custom request header such as `swarm-only-root-chunk` triggers a preflight that the gateway's allow-list refuses |

KINETIC's stamps and feed updates are byte-for-byte identical to bee-js 13.2's `Stamper` and `makeSingleOwnerChunk` for the same key and inputs.

So, with no batch of our own, everything works and storage stays temporary. With a batch, the gateway can't use it from a batch id. It can carry stamps signed client-side by the batch owner, on `/chunks` and `/soc`. KINETIC does that when `SWARM_STAMP_KEY` is set. The one thing not yet seen live is the gateway accepting a stamp from a batch that really exists. The first stamped upload proves it, and `npm run doctor` makes one.

## How KINETIC uses a batch

| Setting | Effect |
|---|---|
| nothing | Gateway-stamped uploads (free, temporary). Passports are erasure-coded (`SWARM_REDUNDANCY_LEVEL`, default 2) |
| `BEE_POSTAGE_BATCH_ID` + `SWARM_STAMP_KEY` + `BEE_POSTAGE_DEPTH` | Every upload is split into chunks in KINETIC and each chunk goes to `/chunks` with its own stamp, through the public gateway. Feed updates go to `/soc` with a stamp |
| `BEE_URL` (your node) + `BEE_POSTAGE_BATCH_ID` | Your node stamps with its own batch (`swarm-postage-batch-id`) |

Notes on client-side stamps:
- A batch has 65,536 buckets of 2^(depth−16) slots, and each stamp takes one slot. All roles share the slot counters in `.kinetic/testnet/state/swarm-stamps-<batch>.json`, updated under a lock. Keep that file. If it is lost, later stamps reuse slots, and in an immutable batch one of two chunks sharing a slot is lost.
- Stamped uploads have no erasure coding: Bee adds parity only when it splits the data itself.
- The `/bzz` copy of each Model Passport, which the feed points at, and the feed manifest are built by Bee, so they still carry the gateway's stamp. The manifest can be re-created at any time (same reference), and the passport bytes themselves are under our batch.

## Cheapest path: buy a batch on Gnosis Chain, owned by our stamp key

This needs no Bee node. You pay the PostageStamp contract directly from a key KINETIC then signs stamps with.

**Cost** (oracle price read on chain on 2026-11-03: 198,569 PLUR per chunk per block; blocks are 5 s; 1 xBZZ = 10^16 PLUR; total = price × blocks × 2^depth):

| Depth | Effective capacity (unencrypted, docs) | 30 days | 90 days |
|---|---|---|---|
| 18 | 6.66 MB | 2.70 xBZZ | 8.10 xBZZ |
| 19 | 112 MB | **5.40 xBZZ** | 16.2 xBZZ |
| 20 | 688 MB | 10.8 xBZZ | 32.4 xBZZ |

xBZZ was about $0.049 that day (CoinGecko), so depth 19 for 30 days is about $0.26. Gas is under 0.001 xDAI. Depth 17 is the protocol minimum but holds only about 45 kB effectively, so it isn't worth buying. A Model Passport is about 10 kB and a job's chunks a few kB each. Depth 18 is enough for a demo; depth 19 leaves room for every upload to be stamped. The price moves; `--dry-run` shows today's figure.

**Steps**

1. **Make a key** for the batch (keep it out of git, like the role keys):
   `node -e "console.log(require('viem/accounts').generatePrivateKey())"`
   Put it in `.env` as `SWARM_STAMP_KEY=0x…`.
2. **See the price and the address to fund**:
   `npm run swarm:stamp -- --onchain --dry-run` (add `--depth 18` or `--days 90` to compare).
3. **Fund the key on Gnosis Chain** (chain id 100):
   - xDAI for gas: about 0.01 is plenty. Withdraw from an exchange that supports Gnosis Chain, or bridge DAI from Ethereum with the Gnosis Bridge.
   - xBZZ, the amount the dry run printed plus a margin, for example 6 xBZZ for depth 19 and 30 days. Either swap xDAI for xBZZ on Gnosis Chain (the SushiSwap V3 BZZ pool, or CoW Swap) or buy BZZ on an exchange and bridge it. The token is `0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da`.
4. **Buy**: `npm run swarm:stamp -- --onchain` (depth 19, 30 days by default). It approves xBZZ to the PostageStamp contract (`0x45a1502382541Cd610CC9068e88727426b696293`), calls `createBatch(owner = the key's address, amount, depth, 16, nonce, immutable = true)` and prints:
   ```
   BEE_POSTAGE_BATCH_ID=…
   BEE_POSTAGE_DEPTH=19
   ```
   Add both to `.env`. Immutable is the right choice for feeds: a mutable batch overwrites old chunks when it fills up.
5. **Wait a few minutes** for Bee nodes to see the batch, then run `npm run doctor`. With `SWARM_STAMP_KEY` set, its Swarm check makes one stamped upload through the gateway. If it reports `invalid batch id`, the gateway hasn't seen the batch yet; try again later.
6. **Roll it out**: run `npm run setup:testnet` (it passes `BEE_POSTAGE_BATCH_ID`, `BEE_POSTAGE_DEPTH` and `SWARM_STAMP_KEY` into the role env files), then restart the network.
7. **Keep it alive**: the batch lasts as long as its balance. To extend it, call `topUp(batchId, amountPerChunk)` on the PostageStamp contract from any funded wallet after approving xBZZ. The cost is amountPerChunk × 2^depth again. For the remaining time, read `remainingBalance(batchId)` on the contract and divide by `lastPrice()`: that gives blocks, at 5 s each. A Bee node shows it as `batchTTL` in `GET /stamps/<batchId>`; the public gateway doesn't serve `/stamps`.

## Other ways

- **Beeport** (beeport.ethswarm.org): buys BZZ from many chains and creates a batch in one step through its `StampsRegistry`, which records both an owner and a node address for the batch. Its upload flow goes through Beeport's own hosted nodes, not KINETIC's pipeline. A Beeport batch is only usable here if the address that can stamp for it is our `SWARM_STAMP_KEY` address. That isn't documented, so prefer the on-chain path above.
- **Your own Bee light node** (Swarm Desktop, or `bee start` with a funded node wallet): `BEE_URL=http://localhost:1633 npm run swarm:stamp -- --depth 20 --amount <PLUR>`, then set `BEE_URL` and `BEE_POSTAGE_BATCH_ID`. This also enables pinning, stewardship and erasure coding on stamped uploads, but it needs xDAI and xBZZ in the node's wallet and a running node.

## Feeds for Model Passports

Each listed model has one feed. The topic is `keccak256("kinetic.model-passport.v1:" + model id)` and the feed is signed by the listing verifier's key, so its owner is a vault verifier. When a version is listed, the verifier uploads the passport to `/bytes`, erasure-coded; that reference goes on Arkiv and HCS. It also uploads the same bytes to `/bzz` and writes a feed update (a v1 payload: timestamp and that `/bzz` reference). The listing records `{ owner, topic, index, target, manifest }`, and `https://api.gateway.ethswarm.org/bzz/<manifest>/` always serves the model's newest passport.

On the model page, the dashboard re-checks everything in the browser:
- **Passport bytes:** fetched chunk by chunk from `/chunks`, checked against the listing's reference (BMT) and the listing's digest.
- **Feed update:** the newest update is fetched as a single-owner chunk at its own address. The browser checks its signature (recovered over the identifier and the wrapped chunk's BMT address), checks the owner is a vault verifier, then confirms the passport it points at is a listed version of the model by digest.

On the public gateway this works with no batch at all. With `SWARM_STAMP_KEY`, feed updates carry our own stamp. `SWARM_FEEDS=false` turns feeds off.
