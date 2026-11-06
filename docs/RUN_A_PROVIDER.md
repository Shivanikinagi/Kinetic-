# Run a KINETIC provider

KINETIC pays community GPUs per chunk of AI work (classification, tagging, extraction) over x402 on Hedera testnet. You bond a little testnet HBAR, publish an offer, and get paid for every chunk you complete. Each chunk carries one hidden known-answer item, so honest work is easy to prove and cheating loses your bond. This guide gets you from nothing to a live provider. Everything runs on testnets: no real money is involved.

## Quick setup

```bash
npm install
npm run kinetic -- init provider    # key, Hedera account, Arkiv gas, compute and price, saved to .kinetic/provider.env
npm run kinetic -- provider         # bonds, publishes your offer on Arkiv, serves /v1/chunks
npm run kinetic -- status provider  # your balance, gas, bond and live offer
```

`init` creates your key and walks you through the two faucets: paste the address it prints into each one. It then finds your compute. With an OpenAI-compatible server running on this machine (e.g. [Ollama](https://ollama.com) with `ollama pull qwen2.5:7b-instruct`), it uses that and detects your NVIDIA GPU. Otherwise pass `--zerog-key` to use 0G Compute. It also asks for your public URL. For a machine at home, run `cloudflared tunnel --url http://localhost:5101` and pass the https URL it prints with `--public-url`. Re-running `init` is safe: it keeps your key and continues where it stopped. The default network is the KINETIC testnet; `--topic`, `--vault` and `--verifier` point it at another.

The rest of this page is the same setup by hand.

## What you need

| | Where | Used for |
|---|---|---|
| Node.js 20+ and this repository | `git clone …` then `npm install` | the provider node |
| A Hedera testnet ECDSA account with ~5 testnet HBAR | [portal.hedera.com](https://portal.hedera.com) | your bond (1 ℏ by default), receiving payments, gas |
| Arkiv testnet gas | [hub.arkiv.network/faucet](https://hub.arkiv.network/faucet), for the same key's EVM address | publishing and renewing your offer |
| Compute | either a 0G Private Computer API key ([pc.0g.ai](https://pc.0g.ai)), or your own OpenAI-compatible server (Ollama, vLLM, llama.cpp) | doing the work |
| A public URL for your node | a server, or a tunnel to your machine | buyers call `POST /v1/chunks` on it |
| Optional: 0G Galileo testnet gas | [faucet.0g.ai](https://faucet.0g.ai), for the same key's EVM address | your ERC-8004 agent identity on 0G Chain, where the verifier records your reputation. Without gas the registration is skipped and the node still serves (`ERC8004=off` turns it off) |

The network operator sends you two values: `HCS_TOPIC_ID` and `BOND_VAULT_ADDRESS`. (Buyers find you on Arkiv; you never call the verifier.)

## Set up by hand

```bash
npm run keys        # prints fresh keys; take the "provider" one and its EVM address
```

Create the Hedera account for that key (ECDSA, with its EVM alias) and fund it; fund the same address at the Arkiv faucet. Then write `.env`:

```bash
KINETIC_NETWORK=testnet
KINETIC_PRIVATE_KEY=0x…            # your provider key: never share it
HEDERA_ACCOUNT_ID=0.0.…
HCS_TOPIC_ID=0.0.…                 # from the operator
BOND_VAULT_ADDRESS=0x…             # from the operator
ARKIV_API_KEY=…                    # recommended: hub.arkiv.network/access-keys

PROVIDER_NAME=your-name
PROVIDER_PUBLIC_URL=https://your-host:5101
PROVIDER_PORT=5101
PROVIDER_PRICE_TINYBAR=100000      # 0.001 ℏ per chunk
PROVIDER_BOND_TINYBAR=100000000    # 1 ℏ
PROVIDER_GPU=what your compute really is

# Either 0G (router) …
PROVIDER_BACKEND=0g
ZEROG_API_KEY=…
PROVIDER_MODEL=0gm-1.0-35b-a3b
# … or your own GPU:
# PROVIDER_BACKEND=openai
# PROVIDER_MODEL_URL=http://localhost:11434/v1
# PROVIDER_MODEL=qwen2.5:7b-instruct
```

## Run

```bash
npm run provider          # bonds, publishes your offer on Arkiv, serves /v1/chunks
npm run register:hol      # optional: list your node in the Hashgraph Online registry (HCS-10)
```

Your offer renews every 30 s; if your node stops, it disappears from Arkiv within 90 s and buyers stop calling it. Your offer also publishes your public key, so chunk keys reach you wrapped to it: only your node can open the chunks it is paid for.

To serve models from the model hub, list them in `PROVIDER_MODELS` (e.g. `PROVIDER_MODELS=kinetic/ticket-classifier`). Your node checks each one's Model Passport and weights before offering it; see [MODEL_HUB.md](MODEL_HUB.md).

## How you're checked, and paid

- **Admission:** before paid work in a task, the verifier pays you for one probe chunk of known answers for that task. You need 80% right.
- **Known answers:** every chunk has one planted labelled item you can't tell from the rest. Missing 3 of your last 10 checks gets you slashed.
- **Slashing takes a quorum:** two of the network's three verifiers each re-check the evidence before signing. You then have a dispute window (60 s on testnet) to challenge a slash with a small challenge bond; all three verifiers re-check it. If upheld, the buyer is refunded from your bond and the rest of it is burned; if overturned, or nobody decides in time, you keep it.
- **Payment:** each chunk is a separate x402 payment in HBAR, settled to your Hedera account only after you've returned the result. Disagreeing with the network's reference model can fail a chunk, but never slashes you.
- **Reputation:** after each job the verifier writes the share of hidden checks you passed to the ERC-8004 Reputation Registry on 0G Chain, if your node registered there.
- **Leaving:** `npm run bonds -- request --yes`, then after 24 h `npm run bonds -- withdraw --yes` (run with your own `.env`: `bonds` reads `.env`, not `.kinetic/provider.env`, so if you set up with `init`, copy `KINETIC_PRIVATE_KEY` and `BOND_VAULT_ADDRESS` from that file into `.env` first).

## An invitation you can send

> We're testing KINETIC, a network that pays independent GPU providers per chunk of AI work, with every result checked against hidden known answers and every payment and slash on Hedera testnet. We'd like a few outside operators so the network isn't all run by us. It takes about 20 minutes, needs only testnet HBAR (free from the Hedera portal) and either a 0G API key or your own GPU, and you can leave at any time. The guide is docs/RUN_A_PROVIDER.md; we'll send you the HCS topic and the vault address. Interested?
