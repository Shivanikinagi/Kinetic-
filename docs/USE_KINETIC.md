# Use KINETIC from your app

KINETIC runs batch AI work (classification, tagging, extraction) on community GPUs. Every chunk you pay for is checked against hidden known answers, and you are refunded automatically if a provider cheats. Everything runs on testnets, so no real money is involved.

Everything runs on your machine, with your key. Your records are encrypted before they leave, you pay each provider directly over x402, and refunds come back to your own address. No KINETIC server sits in between. The one network service you rely on is the verifier, which checks the work. Slashing a provider takes 2 of 3 verifiers, and on testnet all three are run by the KINETIC team.

## 1. Set up (about 5 minutes)

You need Node.js 20+ and this repository (`npm install`).

```bash
npm run kinetic -- init buyer
```

It walks you through the setup:

1. **Creates your key** and saves it to `.kinetic/buyer.env`. That folder is git-ignored. Never share the file.
2. **Hedera account.** Paste the address it prints into the [Hedera faucet](https://portal.hedera.com/faucet). The faucet creates your account, and `init` notices and activates it. If you already have a funded testnet account, add `--operator-id 0.0.x --operator-key <key>` and `init` creates the account from it instead.
3. **Arkiv gas.** Paste the same address into the [Arkiv faucet](https://hub.arkiv.network/faucet).
4. **Network and limits.** It sets the HCS topic, the bond vault, the verifier URL (ask the network operator for it) and your spending limits: 0.005 ℏ per chunk and 0.5 ℏ per job by default.

`init` is safe to re-run: it keeps your key and continues where it stopped. Check your setup at any time with:

```bash
npm run kinetic -- status buyer
```

## 2. Run a job from the command line

```bash
npm run kinetic -- tasks                                  # built-in tasks
npm run kinetic -- run --task sentiment                   # its sample items
npm run kinetic -- run --task sentiment --items my.jsonl  # your own: one {"id","text"} per line
npm run kinetic -- models                                 # models listed in the model hub
npm run kinetic -- run --model kinetic/review-sentiment --items my.jsonl  # a listed model; its creator earns a royalty
```

Ctrl-C stops new paid work. Chunks already in flight finish. The report goes to `out/`.

## 3. Run a job from your code

```ts
import { Kinetic } from "./src/sdk/index.js";

const kinetic = new Kinetic({
  privateKey: process.env.KINETIC_PRIVATE_KEY as `0x${string}`,
  hederaAccountId: process.env.HEDERA_ACCOUNT_ID,
  verifierUrl: process.env.VERIFIER_URL,
  budget: { maxPricePerChunk: "0.005", maxJobSpend: "0.5" }, // HBAR
  onEvent: (e) => console.log(e.message),                    // admission, payments, canaries, slashes, reroutes
});
// Or: Kinetic.fromEnv(settingsFromYourBuyerEnv)

const report = await kinetic.run({
  task: "sentiment",                       // a built-in task, or your own { kind, instructions, labels }
  items: ["Love it", "Broke in a day"],    // strings, or { id, text }
  agreement: { canaryRate: 0.5, deadlineSeconds: 600 },
});

report.results;          // [{ id: "1", label: "positive" }, …]
report.paidTinybar;      // what you paid providers
report.refundedTinybar;  // what came back from slashed providers
report.passport.url;     // the Compute Passport: public proof of how every chunk was checked
```

Other methods:

- `kinetic.providers("classify")` lists the bonded providers you could use, best first.
- `kinetic.halt()` is the kill switch. `kinetic.resume()` turns work back on.
- `Kinetic.tasks()` lists the built-in tasks.
- `kinetic.run({ model: "kinetic/review-sentiment", items, budget: "0.5 HBAR" })` runs a listed model instead of a task. `kinetic.models()`, `kinetic.model(id)`, `kinetic.passport(id)` and `kinetic.publish({ card, files })` cover the rest of the model hub: see [MODEL_HUB.md](MODEL_HUB.md).

**Built-in tasks vs. your own.** The built-in tasks marked "known answers" in `npm run kinetic -- tasks` have labelled examples, so a provider that answers them wrong is slashed and you are refunded. Your own task definition gets format and model checks only, and the SDK says so in an event.

**Not published to npm yet.** For now, import from `src/sdk/index.ts` in this repository (run it with `tsx`). The SDK is Node only, because it holds a key that pays.
