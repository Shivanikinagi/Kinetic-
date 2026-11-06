import "../src/env.js";
import { AccountCreateTransaction, AccountId, Client, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import type { Server } from "node:http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { identityFromEnv, loadNetworkConfig } from "../src/config.js";
import { HederaReceiptLog } from "../src/integrations/hcs.js";
import { creditedAmount } from "../src/integrations/mirror.js";
import { EvmBondVault } from "../src/integrations/vault.js";
import { HederaPaymentSigner, mirrorTransactionId, PaymentGate, payFetch } from "../src/integrations/x402.js";
import { createApp, listen } from "../src/util/http.js";
import { loadRoleEnv, ROLES } from "../src/testnet/roles.js";
import { quorumSignatures, signDigest, verdictDigest, type SlashVerdict } from "../src/core/verdict.js";

// Live Hedera smoke test, no Arkiv or 0G needed. Uses a throwaway provider account so the
// testnet providers' bonds stay clean. Spends well under 1 testnet HBAR plus the throwaway's 3.
//   1. x402: buyer pays a protected endpoint through the x402.org facilitator
//   2. mirror node: the payment is confirmed independently
//   3. HCS: the verifier writes a receipt
//   4. vault: the throwaway posts a bond; the verifiers sign a slash, which executes after the
//      dispute window and refunds the buyer

const hashscan = (id: string) => `https://hashscan.io/testnet/transaction/${id.startsWith("0x") ? id : mirrorTransactionId(id)}`;
const operatorKey = process.env.OPERATOR_KEY!.startsWith("0x") ? PrivateKey.fromStringECDSA(process.env.OPERATOR_KEY!.slice(2)) : PrivateKey.fromStringDer(process.env.OPERATOR_KEY!);
const operator = Client.forTestnet().setOperator(AccountId.fromString(process.env.OPERATOR_ID!), operatorKey);

const verifierEnv = loadRoleEnv("verifier");
const buyerEnv = loadRoleEnv("buyer");
const cfg = loadNetworkConfig(verifierEnv);
const verifier = identityFromEnv(verifierEnv);
const buyer = identityFromEnv(buyerEnv);

// Throwaway provider.
const providerKeyHex = generatePrivateKey();
const created = await new AccountCreateTransaction()
  .setECDSAKeyWithAlias(PrivateKey.fromStringECDSA(providerKeyHex.slice(2)))
  .setInitialBalance(new Hbar(3))
  .execute(operator);
const providerId = (await created.getReceipt(operator)).accountId!.toString();
const providerAddress = privateKeyToAccount(providerKeyHex).address;
console.log(`throwaway provider ${providerId} ${providerAddress}`);

// 1. x402 payment.
const price = 100_000n;
const gate = new PaymentGate({ network: cfg.x402.network, facilitatorUrl: cfg.x402.facilitatorUrl, facilitatorUrls: cfg.x402.facilitatorUrls, asset: "0.0.0", payTo: providerId, amount: price, description: "KINETIC smoke test chunk" });
const app = createApp();
app.post("/v1/chunks", (req, res) => void gate.handle(req, res, async () => ({ ok: true, echo: req.body })));
const server: Server = await listen(app, 5199);
const paid = await payFetch(
  "http://localhost:5199/v1/chunks",
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chunk: 0 }) },
  new HederaPaymentSigner(buyer, cfg.hedera.mirrorUrl),
  500_000n,
);
server.closeAllConnections();
server.close();
if (!paid.response.ok || !paid.settlement?.success) throw new Error(`x402 failed: ${paid.response.status} ${await paid.response.text()}`);
const payTx = paid.settlement.transaction;
console.log(`1. x402 settled ${price} tinybar buyer → provider: ${hashscan(payTx)}`);

// 2. Independent confirmation.
const credited = await creditedAmount(cfg.hedera.mirrorUrl, payTx, providerId);
console.log(`2. mirror node credits provider ${credited} tinybar ${credited === price ? "✓" : "✗"}`);

// 3. HCS receipt.
const receipts = new HederaReceiptLog(verifier, cfg.hedera.hcsTopicId);
const receipt = await receipts.submit({ t: "chunk", job: "smoke-test", idx: 0, provider: providerAddress.toLowerCase(), resultHash: "smoke", payTx, amount: credited.toString() });
console.log(`3. HCS receipt #${receipt.sequence}: https://hashscan.io/testnet/topic/${cfg.hedera.hcsTopicId}`);

// 4. Bond, then slash to refund the buyer.
const providerVault = new EvmBondVault(privateKeyToAccount(providerKeyHex), cfg.hedera.vaultAddress!, cfg.hedera);
const bondTx = await providerVault.postBond(50_000_000n);
console.log(`4a. bond 0.5 ℏ posted: ${hashscan(bondTx)}`);
const verifierVault = new EvmBondVault(privateKeyToAccount(verifier.privateKey), cfg.hedera.vaultAddress!, cfg.hedera);
const buyerAddress = privateKeyToAccount(buyer.privateKey).address;
// Every verifier key on this machine signs the verdict; the vault needs its threshold of them.
const info = await verifierVault.info();
const verdict: SlashVerdict = { provider: providerAddress, buyer: buyerAddress, jobId: `smoke-${Date.now()}`, chunk: 0, resultHash: "00".repeat(32), refundTinybar: credited, evidence: `hcs:${cfg.hedera.hcsTopicId}#${receipt.sequence}` };
const digest = verdictDigest(verdict, info);
const keys = ROLES.filter((r) => r.role === "verifier" || r.cosigner).map((r) => identityFromEnv(loadRoleEnv(r.role)).privateKey);
const quorum = await quorumSignatures(digest, await Promise.all(keys.map((k) => signDigest(privateKeyToAccount(k), digest))), info.verifiers);
const proposed = await verifierVault.proposeSlash(verdict, quorum.signatures.slice(0, Math.max(info.threshold, 1)));
console.log(`4b. slash proposed with ${Math.max(info.threshold, 1)} of ${info.verifiers.length} verifier signatures: ${hashscan(proposed.tx)}`);
console.log(`    waiting out the ${info.disputeWindowSeconds}s dispute window`);
await new Promise((r) => setTimeout(r, (info.disputeWindowSeconds + 5) * 1000));
const settled = await verifierVault.executeSlash(proposed.slashId);
const after = await verifierVault.bondOf(providerAddress);
console.log(`4c. executed, refunded ${settled.refundTinybar} tinybar to buyer, burned ${settled.burnedTinybar}: ${hashscan(settled.tx)}`);
console.log(`    bond now ${after.amountTinybar} tinybar, slashed=${after.slashed}`);
operator.close();
process.exit(0);
