import "../src/env.js";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, formatEther, http, parseAbi, parseEventLogs, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gnosis } from "viem/chains";

// Buys a Swarm postage batch, so KINETIC's uploads (passports above all) are paid storage that
// lasts for the batch's lifetime, instead of the public gateway's free uploads, which are kept
// only for a while. Two ways (docs/SWARM_STAMP.md):
//
//   --onchain: straight from the PostageStamp contract on Gnosis Chain, owned by SWARM_STAMP_KEY.
//   KINETIC then signs stamps itself and keeps using the public gateway, which forwards them.
//   The key's address needs xBZZ (the batch) and a little xDAI (gas) on Gnosis Chain.
//
//     SWARM_STAMP_KEY=0x… npm run swarm:stamp -- --onchain [--depth 19] [--days 30] [--dry-run]
//
//   Own Bee node: BEE_URL is your node's API, which buys from its own funded wallet.
//
//     BEE_URL=http://localhost:1633 npm run swarm:stamp -- [--amount 1000000000] [--depth 20]
//
// Prints the env lines to put in .env (and re-run npm run setup:testnet to pass them on).

const { values } = parseArgs({
  options: {
    onchain: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    amount: { type: "string" },
    depth: { type: "string" },
    days: { type: "string", default: "30" },
    rpc: { type: "string", default: process.env.GNOSIS_RPC_URL || "https://rpc.gnosischain.com" },
  },
});

if (values.onchain) await onchain();
else await ownNode();

async function onchain() {
  // Swarm mainnet contracts on Gnosis Chain (ethersphere/go-storage-incentives-abi, abi_mainnet.go).
  const POSTAGE_STAMP = "0x45a1502382541Cd610CC9068e88727426b696293";
  const BZZ = "0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da";
  const BLOCK_SECONDS = 5;
  const postage = parseAbi([
    "function lastPrice() view returns (uint64)",
    "function minimumValidityBlocks() view returns (uint64)",
    "function minimumBucketDepth() view returns (uint8)",
    "function createBatch(address _owner, uint256 _initialBalancePerChunk, uint8 _depth, uint8 _bucketDepth, bytes32 _nonce, bool _immutable)",
    "event BatchCreated(bytes32 indexed batchId, uint256 totalAmount, uint256 normalisedBalance, address owner, uint8 depth, uint8 bucketDepth, bool immutableFlag)",
  ]);
  const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address, address) view returns (uint256)", "function approve(address, uint256) returns (bool)"]);

  const key = process.env.SWARM_STAMP_KEY;
  if (!key) throw new Error("SWARM_STAMP_KEY is required: the Gnosis Chain key that will own the batch and sign stamps");
  const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
  const chain = createPublicClient({ chain: gnosis, transport: http(values.rpc) });
  const depth = Number(values.depth ?? 19);
  const bucketDepth = await chain.readContract({ address: POSTAGE_STAMP, abi: postage, functionName: "minimumBucketDepth" });
  if (depth <= bucketDepth) throw new Error(`depth must be above ${bucketDepth}`);
  const price = await chain.readContract({ address: POSTAGE_STAMP, abi: postage, functionName: "lastPrice" });
  const minBlocks = await chain.readContract({ address: POSTAGE_STAMP, abi: postage, functionName: "minimumValidityBlocks" });
  // amount = PLUR per chunk = price per chunk per block × blocks; total = amount × 2^depth.
  const blocks = BigInt(Math.round((Number(values.days) * 86_400) / BLOCK_SECONDS));
  const amount = values.amount ? BigInt(values.amount) : price * blocks;
  if (amount < price * minBlocks) throw new Error(`amount must cover at least ${minBlocks} blocks (24 h): ${price * minBlocks} PLUR per chunk`);
  const total = amount << BigInt(depth);
  const bzz = (plur: bigint) => `${(Number(plur) / 1e16).toFixed(4)} xBZZ`;
  const [bzzBalance, xdai] = await Promise.all([chain.readContract({ address: BZZ, abi: erc20, functionName: "balanceOf", args: [account.address] }), chain.getBalance({ address: account.address })]);
  console.log(`price ${price} PLUR per chunk per block (oracle); depth ${depth} (${2 ** depth} chunks), ${values.amount ? `amount ${amount}` : `${values.days} days`}`);
  console.log(`batch costs ${bzz(total)} (amount ${amount} PLUR per chunk); lifetime about ${(Number(amount / price) * BLOCK_SECONDS / 86_400).toFixed(1)} days at today's price`);
  console.log(`owner ${account.address}: ${bzz(bzzBalance)}, ${formatEther(xdai)} xDAI`);
  if (bzzBalance < total || xdai < 10n ** 15n) {
    console.log(`\nnot enough to buy: needs ${bzz(total)} and about 0.001 xDAI for gas on Gnosis Chain (docs/SWARM_STAMP.md, "Fund the key")`);
    process.exit(values["dry-run"] ? 0 : 1);
  }
  if (values["dry-run"]) return;

  const wallet = createWalletClient({ account, chain: gnosis, transport: http(values.rpc) });
  const allowance = await chain.readContract({ address: BZZ, abi: erc20, functionName: "allowance", args: [account.address, POSTAGE_STAMP] });
  if (allowance < total) {
    const hash = await wallet.writeContract({ address: BZZ, abi: erc20, functionName: "approve", args: [POSTAGE_STAMP, total] });
    await chain.waitForTransactionReceipt({ hash });
    console.log(`approved ${bzz(total)} to the PostageStamp contract (${hash})`);
  }
  const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
  const hash = await wallet.writeContract({ address: POSTAGE_STAMP, abi: postage, functionName: "createBatch", args: [account.address, amount, depth, bucketDepth, nonce, true] });
  const receipt = await chain.waitForTransactionReceipt({ hash });
  const [created] = parseEventLogs({ abi: postage, eventName: "BatchCreated", logs: receipt.logs });
  if (!created) throw new Error(`createBatch ${hash} emitted no BatchCreated`);
  const batchId = created.args.batchId.slice(2);
  console.log(`batch ${batchId} created (${hash}); Bee nodes see it after a few minutes`);
  console.log(`\nBEE_POSTAGE_BATCH_ID=${batchId}\nBEE_POSTAGE_DEPTH=${depth}\nSWARM_STAMP_KEY=<the key you used>`);
}

async function ownNode() {
  const bee = (process.env.BEE_URL || "").replace(/\/$/, "");
  if (!bee || /gateway\.ethswarm\.org/.test(bee)) {
    console.error("BEE_URL must point at your own Bee node's API (e.g. http://localhost:1633), not the public gateway; or buy on chain with --onchain");
    process.exit(2);
  }
  const amount = values.amount ?? "1000000000";
  const depth = values.depth ?? "20";

  const health = await fetch(`${bee}/health`).catch(() => undefined);
  if (!health?.ok) throw new Error(`no Bee node answering at ${bee}`);

  console.log(`buying a postage batch on ${bee}: amount ${amount}, depth ${depth}`);
  const res = await fetch(`${bee}/stamps/${amount}/${depth}`, { method: "POST" });
  if (!res.ok) throw new Error(`Bee refused the purchase (${res.status}): ${await res.text()}`);
  const { batchID } = (await res.json()) as { batchID: string };
  console.log(`batch ${batchID} bought; waiting for it to become usable (usually a minute or two)…`);

  for (let i = 0; i < 120; i++) {
    const s = await fetch(`${bee}/stamps/${batchID}`).then((r) => (r.ok ? (r.json() as Promise<{ usable?: boolean; batchTTL?: number }>) : undefined));
    if (s?.usable) {
      console.log(`usable. lifetime about ${Math.round((s.batchTTL ?? 0) / 86_400)} days`);
      console.log(`\nBEE_URL=${bee}\nBEE_POSTAGE_BATCH_ID=${batchID}`);
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`batch ${batchID} still not usable after 10 minutes; check it with GET ${bee}/stamps/${batchID}`);
}
