import "../src/env.js";
import { AccountId, Client, PrivateKey, TopicCreateTransaction } from "@hiero-ledger/sdk";
import { identityFromEnv } from "../src/config.js";

// Creates the HCS receipts topic. Run it with the verifier's key: that key becomes the
// topic's submit key, so only the verifier can append receipts.

const identity = identityFromEnv();
if (!identity.hederaAccountId) throw new Error("HEDERA_ACCOUNT_ID is required");
const key = PrivateKey.fromStringECDSA(identity.privateKey.slice(2));
const client = Client.forTestnet().setOperator(AccountId.fromString(identity.hederaAccountId), key);

const response = await new TopicCreateTransaction().setTopicMemo("KINETIC audit receipts").setSubmitKey(key.publicKey).execute(client);
const receipt = await response.getReceipt(client);
console.log(`created topic ${receipt.topicId} (tx ${response.transactionId})`);
console.log(`HashScan: https://hashscan.io/testnet/topic/${receipt.topicId}`);
console.log(`\nHCS_TOPIC_ID=${receipt.topicId}`);
client.close();
