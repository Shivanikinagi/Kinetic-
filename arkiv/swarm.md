# Swarm with Arkiv in KINETIC

KINETIC is a market for verified AI compute. Arkiv holds the market's live state: offers, jobs, chunk claims, checks and model listings. Swarm holds the files those entities point to. Every link from Arkiv to Swarm is a field on an entity, and every file read back from Swarm is checked against its content address, so neither the gateway nor we can swap a file.

## What lives where

| On Swarm | On Arkiv | The Arkiv field that holds the reference |
|---|---|---|
| A job's **Compute Passport**: the signed record of a job's results, checks and payments | `kinetic.job` entity, owned by the buyer's wallet | `audit_ref` attribute: a plain 64-hex Swarm reference |
| A listed model's **Model Passport** | `kinetic.model` entity, owned by a vault verifier | `passport_ref` attribute, plus `passport_digest` |
| The model's **passport feed** | the same `kinetic.model` entity | payload `feed`: `{ owner, topic, index, target, manifest }` |
| A job's **input chunks and results**, AES-GCM sealed | `kinetic.chunk` entity | payload `encRef` and `resultRef`, each **sealed with AES-GCM before it goes on Arkiv** |
| **Model weights**, when a creator picks Swarm | `kinetic.model` entity | payload card `weights.files[].swarmRef` |

Arkiv entities are public, so:
- Uploads use **plain 64-hex references**. Swarm-layer encryption is off on the public gateway, because a 128-hex reference contains its own decryption key.
- Private data (chunk inputs and results) is sealed with AES-GCM before upload.
- Its references are sealed again before they go into an entity.

The full schema is in [schema.md](schema.md).

## Example entities you can open

**1. A finished job and its Compute Passport.**
- Arkiv entity: [`0xad8e98ce…6115396`](https://rabdi.explorer.arkiv.network/entity/0xad8e98ce06b1f90564a7f8c9187836e69f6df6a5370f9b1169494637e6115396), `kinetic.job`, `job_id = job-mw3qzkrd-585265` (Rabdi testnet, chain 7794095).
- `audit_ref`: [`84964866a8c2e58b8e086134a0ba2d3f9143af0ab180a8ae74d5a2f3e89eb58d`](https://api.gateway.ethswarm.org/bytes/84964866a8c2e58b8e086134a0ba2d3f9143af0ab180a8ae74d5a2f3e89eb58d).
- Job entities expire 7 days after the job, so this one lasts until 2026-11-12. A copy of the passport is in [evidence/](../evidence/2026-11-05-job-mw3qzkrd-585265/passport.json).

**2. A listed model and its feed.**
- Arkiv entity: [`0xf82f60a0…f546b512`](https://rabdi.explorer.arkiv.network/entity/0xf82f60a0894b23fa2e24c44a7765eb887f2319c7b79e6d163b02bf55f546b512), `kinetic.model`, `kinetic/ticket-classifier@1.0.2`.
- `passport_ref`: [`d41772497e106376e536c63d30bdfa7a3ce3b2e940ce065f26cb68bbad297ca3`](https://api.gateway.ethswarm.org/bytes/d41772497e106376e536c63d30bdfa7a3ce3b2e940ce065f26cb68bbad297ca3).
- Feed, which always serves the newest passport: [`/bzz/72c67321…3136/`](https://api.gateway.ethswarm.org/bzz/72c67321391d5085e577b58146f76b985f756c8b9d6f513149012e0ea6893136/).

## Postage batch and Bee node

**Postage batch ID:** `a0ad7c3205bb20d6fd76cbcec0ab393d38ca4ce1fcdba3d491e4a088e5756360`

| | |
|---|---|
| Bought by | our Bee node's wallet [`0x926b81921407df891a4ab6efdfbe8aacc9532f44`](https://gnosisscan.io/address/0x926b81921407df891a4ab6efdfbe8aacc9532f44) on Gnosis Chain |
| Purchase tx | [`0x4e509cdb…78b6`](https://gnosisscan.io/tx/0x4e509cdb4a11e29693faa52f00e2f220aecc4393cea316149b396307b0a278b6), block 49136988, 2026-11-06 |
| Batch | immutable, depth 19 (about 112 MB), amount 48,700,000,000 per chunk: about 2.55 xBZZ for 14 days |
| Expires | about 2026-11-20, sooner if the storage price rises; it can be topped up |
| Bee node | a light node, Bee 2.8.3, run by the Nook desktop app |
| One upload stamped with it | [`213b31f5…86f9`](https://api.gateway.ethswarm.org/bytes/213b31f57ffcf1ffc4393b106b0e5b24f2c269c93a913b61bd242e40a70686f9), uploaded to our node with `swarm-postage-batch-id` and read back through the public gateway |

How KINETIC uses it:
- **Uploads** go to our own node, with `BEE_URL=http://localhost:1633` and `BEE_POSTAGE_BATCH_ID` in `.env`. The node owns the batch, so it stamps the uploads itself.
- **Reads and every link** we write go through the public gateway, with `SWARM_GATEWAY_URL=https://api.gateway.ethswarm.org`, so anyone can open them without a node.
- **Without our node,** for example a judge running the commands below, uploads fall back to the public gateway's own batch.

We also built a second path, for when no node is available: KINETIC signs each chunk's stamp itself and uploads through the public gateway (`SWARM_STAMP_KEY`, [docs/SWARM_STAMP.md](../docs/SWARM_STAMP.md)). The batch above uses the node path.

Uploads made before 2026-11-06, including the two examples above, were stamped with the gateway's own batch.

## The code that uploads to Swarm and reads from it

| File | What it does |
|---|---|
| [src/integrations/swarm.ts](../src/integrations/swarm.ts) | The Swarm client: uploads, verified downloads, feeds, and stamped uploads through `/chunks` and `/soc` |
| [src/integrations/swarm-bmt.ts](../src/integrations/swarm-bmt.ts) | Content addresses: splits files into chunks and checks downloaded chunks against the reference |
| [src/integrations/swarm-feed.ts](../src/integrations/swarm-feed.ts) | Feed topics, single-owner chunks, feed updates and postage stamp signatures |
| [src/integrations/swarm-stamper.ts](../src/integrations/swarm-stamper.ts) | Slot counters for a batch we own |
| [src/agent/buyer.ts](../src/agent/buyer.ts) | Uploads the sealed input chunks, the sealed results and the Compute Passport; writes `audit_ref` and the sealed `encRef` and `resultRef` on Arkiv |
| [src/provider/node.ts](../src/provider/node.ts) | A provider downloads its sealed chunk from Swarm |
| [src/verifier/verifier.ts](../src/verifier/verifier.ts), [src/verifier/cosigner.ts](../src/verifier/cosigner.ts) | Verifiers read chunks and results from Swarm to check them |
| [src/verifier/models.ts](../src/verifier/models.ts) | Uploads Model Passports, publishes their feeds, writes `passport_ref` on the `model` entity |
| [src/models/registry.ts](../src/models/registry.ts), [src/models/publish.ts](../src/models/publish.ts), [src/models/weights.ts](../src/models/weights.ts) | Read listings and passports; upload and fetch model weights |
| [web/src/swarm.ts](../web/src/swarm.ts) | The dashboard re-checks passports and feed updates in the browser |
| [scripts/verify-passport.ts](../scripts/verify-passport.ts) | `npm run passport:verify`: downloads a Compute Passport and checks all of it |
| [scripts/swarm-roundtrip.ts](../scripts/swarm-roundtrip.ts) | `npm run swarm:roundtrip`: one upload and one read, described below |
| [scripts/swarm-stamp.ts](../scripts/swarm-stamp.ts) | `npm run swarm:stamp`: buys a postage batch |

## Run one upload and one read yourself

You need Node 20 or later and an internet connection. You need **no keys, wallet or `.env`**: without a batch, uploads go through the public gateway.

```bash
cd KINETIC
npm install

# 1. Upload, then read back through the same client KINETIC uses
npm run swarm:roundtrip -- --text "hello from a judge"
```

You should see a 64-hex reference, a gateway link you can open, and `read back 18 bytes, identical`.

```bash
# 2. Follow an Arkiv entity to Swarm: read the job entity, then download its audit_ref
npm run swarm:roundtrip -- --job job-mw3qzkrd-585265
```

You should see:

```
Arkiv entity  0xad8e98ce06b1f90564a7f8c9187836e69f6df6a5370f9b1169494637e6115396
audit_ref     84964866a8c2e58b8e086134a0ba2d3f9143af0ab180a8ae74d5a2f3e89eb58d
Swarm read    50001 bytes, every chunk checked against its content address
passport for  job-mw3qzkrd-585265
```

To check what the passport says (signatures, payments, the slash, the TEE signatures):

```bash
npm run passport:verify -- 84964866a8c2e58b8e086134a0ba2d3f9143af0ab180a8ae74d5a2f3e89eb58d \
  --results evidence/2026-11-05-job-mw3qzkrd-585265/results.json
```

## Swarm in the demo video

**2:12 to 2:20:** "Arkiv serves live listings linked to Swarm artifacts; Swarm holds the signed Compute Passport, verifiable with one command."

<!-- TODO(team): check this timestamp against the final cut you submit. -->

## What got in our way

1. **The public gateway ignores `swarm-postage-batch-id`.** A batch ID only works on the Bee node that owns the batch. To use a batch of our own without running a node, we sign each chunk's stamp ourselves and send chunks to `/chunks` and `/soc`.
2. **Pre-signed stamps aren't accepted on `/bytes`**, which returns 400. The [Bee API spec](https://github.com/ethersphere/bee/blob/master/openapi/Swarm.yaml) (8.2.2) agrees: the `swarm-postage-stamp` header exists only on `/chunks` and `/soc`, and `/bytes`, `/bzz` and `/feeds` take only `swarm-postage-batch-id`. None of the guides on docs.ethswarm.org cover stamping on the client, so we followed the spec and bee-js. So stamped uploads are split into chunks in KINETIC, and they lose Bee's erasure coding, which Bee adds only when it splits the data itself.
3. **Gateway storage is temporary, and it bit us live.**
   - An older audit bundle became unreachable within days.
   - On 2026-11-06 the Model Passport for `ticket-classifier@1.0.1` disappeared, which left every provider with no models at start-up.
   - We fixed that: providers now skip a listing they can't fetch instead of serving nothing, and we re-listed the model as 1.0.2.
   - The real fix is our own batch, which we've had since 2026-11-06.
4. **There's no test-token path for a batch the public gateway honours.** Buying one needs xBZZ and xDAI on Gnosis Chain mainnet.
5. **Our own node needed a long first sync.** Before it can read or buy batches, a new Bee node syncs postage events from Gnosis Chain: about 15 minutes for us, with `/stamps` and `/wallet` answering `503 Node is syncing` in the meantime. Then the node restarted itself to use its funds.
6. **Encrypted references carry their key.** We keep Swarm encryption off on the gateway, seal the data with AES-GCM ourselves, and seal the references again before they go on Arkiv.
7. **Feeds need a manifest.** `/bzz/<feed>/` serves only an update that points at a manifest; a raw `/bytes` reference gives 404. So each passport is uploaded twice: to `/bytes` for the reference on Arkiv, and to `/bzz` for the feed.
8. **Browser limits:**
   - A custom header such as `swarm-only-root-chunk` triggers a CORS preflight that the gateway refuses, so the dashboard fetches chunks one by one.
   - The newest feed index lags a few seconds behind a write.
