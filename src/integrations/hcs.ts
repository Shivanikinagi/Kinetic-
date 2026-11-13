import { AccountId, Client, PrivateKey, TopicId, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import type { Identity, NetworkConfig } from "../config.js";
import { jsonReplacer } from "../util/crypto.js";

// HCS is KINETIC's tamper-evident audit log. The topic's submit key is the verifier's key,
// so only the verifier can append, and the mirror node gives anyone a public read path.

export type Receipt =
  // `agreement` is the hash of the rules the buyer set for the job (absent on older receipts).
  // `known`: commitment to where known-answer items were planted (absent when none were).
  // `model`: the listed model the job runs (its key), when the buyer chose one.
  // `spot`: how many chunks a PRNG seed drawn after the reveal will pick to re-check (core/spot.ts).
  | { t: "job"; job: string; buyer: string; chunks: number; task: string; commitment: string; agreement?: string; known?: string; model?: string; spot?: number }
  // A Model Passport issued: the model version (key, id, version), the passport's digest and
  // 0G Storage root, its benchmark accuracy, and the verifiers whose signatures carried it.
  | { t: "model"; model: string; id: string; version: string; creator: string; royaltyBps: number; digest: string; ref: string; accuracy: number; signers: string[] }
  // The creator's royalty for a job, paid by the buyer over x402 straight to the creator.
  // `basis`: the accepted chunk payments it was computed on. Amounts are tinybar.
  | { t: "royalty"; job: string; model: string; payTo: string; amount: string; basis: string; chunks: number; tx: string }
  // High assurance: two independent providers' copies of a chunk agreed; the first one is kept.
  | { t: "redundant"; job: string; idx: number; providers: string[]; agreement: number; outvoted: string[] }
  // A chunk scored against the known answers planted in it. Misses count toward slashing.
  | { t: "known"; job: string; idx: number; provider: string; items: number; correct: number; pass: boolean }
  // Amounts are tinybar. `asset` appears only on receipts from before payments became
  // HBAR-only, naming the HTS token those jobs settled in.
  // `zg`, `chat`, `m`: the 0G Compute provider that ran it, its chat id and model. `pt`/`pid`: decentralized
  // node or centralized relay (and to whom). `att`: the verifier's attestation check, `why` when not verified.
  | { t: "chunk"; job: string; idx: number; provider: string; resultHash: string; payTx: string; amount: string; asset?: string; zg?: string; chat?: string; m?: string; pt?: string; pid?: string; att?: "verified" | "unavailable" | "invalid"; why?: string }
  // `pass`: met the protocol's bar (counts toward slashing). `accepted`: met this job's agreed pass mark.
  | { t: "canary"; job: string; idx: number; provider: string; agreement: number; pass: boolean; accepted?: boolean; ref: string }
  // A slash the vault accepted. `refund` is what it asks for; `settle` says what happened. `signers`: the verifier quorum.
  | { t: "slash"; job: string; provider: string; buyer: string; refund: string; vaultTx: string; failures: number; window: number; uaid?: string; slashId?: string; signers?: string[] }
  // Not enough verifiers confirmed the failures, so there was no slash.
  | { t: "slash-refused"; job: string; provider: string; signers: string[]; need: number; reasons: string[] }
  // The provider disputed a slash, and how the verifiers voted on re-checking it.
  | { t: "dispute"; job: string; provider: string; slashId: string; upheld: number; overturned: number }
  // `outcome`: executed (refund paid, rest of the bond burned), overturned or cancelled (bond kept).
  | { t: "settle"; job: string; provider: string; slashId: string; outcome: "executed" | "overturned" | "cancelled"; refund: string; burned: string; vaultTx: string; scheduled?: boolean }
  | { t: "reveal"; job: string; canaries: number[]; salt: string; known?: { idx: number; ids: string[] }[]; knownSalt?: string }
  // `job` is set when the probe used that job's own examples.
  | { t: "qualify"; provider: string; job?: string; admitted: boolean; agreement: number; latencyMs: number; payTx: string; reason?: string; uaid?: string }
  // The model check: does the provider answer like the model it declares?
  | { t: "fingerprint"; provider: string; declared: string; verdict: string; match: number; closest?: string; payTx: string; uaid?: string }
  | { t: "format"; job: string; idx: number; provider: string; problems: string[] }
  // One Merkle root over the job's finished chunks (core/merkle.ts), in the shape of Hedera's
  // batch-anchor tutorial (`schema` … `merkleRoot`), plus `t` and `job` like every receipt here.
  | { t: "anchor"; job: string; schema: "hcs.merkleRootAnchor"; schemaVersion: "1"; leaf: "kinetic.chunk.v1"; recordCount: number; hashAlg: "sha256"; merkleRoot: string; createdAt: string }
  // Spot checks after the job closed: chunks picked by a Hedera PRNG seed drawn in the vault
  // (core/spot.ts) after the reveal, re-run on 0G. `drawnAt`: the seed's consensus second.
  | { t: "spot"; job: string; seed: string; drawnAt: number; seedTx?: string; picks: number[]; checked: { idx: number; provider: string; agreement?: number; pass?: boolean; ref?: string }[] }
  | { t: "done"; job: string; verified: number; paid: string; refunded: string; fee: string; asset?: string };

export interface ReceiptLog {
  readonly topicId: string;
  submit(receipt: Receipt): Promise<{ sequence: number; tx?: string }>;
}

export class HederaReceiptLog implements ReceiptLog {
  private readonly client: Client;

  constructor(identity: Identity, readonly topicId: string) {
    if (!identity.hederaAccountId) throw new Error("HEDERA_ACCOUNT_ID is required to write HCS receipts");
    this.client = Client.forTestnet().setOperator(
      AccountId.fromString(identity.hederaAccountId),
      PrivateKey.fromStringECDSA(identity.privateKey.slice(2)),
    );
  }

  async submit(receipt: Receipt) {
    const response = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(this.topicId))
      .setMessage(JSON.stringify({ v: 1, ...receipt }, jsonReplacer))
      .execute(this.client);
    const result = await response.getReceipt(this.client);
    return { sequence: Number(result.topicSequenceNumber ?? 0), tx: response.transactionId.toString() };
  }
}

export class DevnetReceiptLog implements ReceiptLog {
  constructor(
    private readonly devnetUrl: string,
    readonly topicId: string,
  ) {}

  async submit(receipt: Receipt) {
    const res = await fetch(`${this.devnetUrl}/devnet/hcs/${this.topicId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: JSON.stringify({ v: 1, ...receipt }, jsonReplacer) }),
    });
    if (!res.ok) throw new Error(`hcs submit failed (${res.status})`);
    return (await res.json()) as { sequence: number };
  }
}

export interface MirrorMessage {
  sequence: number;
  consensusTimestamp: string;
  receipt: Receipt & { v: number };
}

/**
 * Every receipt for one job, newest first. Pages back through the topic (following the mirror
 * node's `links.next`) until it reaches the job's first receipt, the `job` commitment.
 */
export async function readJobReceipts(mirrorUrl: string, topicId: string, jobId: string, maxPages = 50): Promise<MirrorMessage[]> {
  const found: MirrorMessage[] = [];
  let next: string | null = `/api/v1/topics/${topicId}/messages?order=desc&limit=100`;
  for (let page = 0; next && page < maxPages; page++) {
    const res = await fetch(`${mirrorUrl}${next}`);
    if (!res.ok) throw new Error(`mirror read failed (${res.status})`);
    const body = (await res.json()) as { messages: { sequence_number: number; consensus_timestamp: string; message: string }[]; links?: { next: string | null } };
    for (const m of body.messages) {
      let receipt: MirrorMessage["receipt"];
      try {
        receipt = JSON.parse(Buffer.from(m.message, "base64").toString("utf8"));
      } catch {
        continue;
      }
      if (!("job" in receipt) || receipt.job !== jobId) continue;
      found.push({ sequence: m.sequence_number, consensusTimestamp: m.consensus_timestamp, receipt });
      if (receipt.t === "job") return found;
    }
    next = body.links?.next ?? null;
  }
  return found;
}

/** Reads receipts back through the Hedera mirror node REST API (emulated on devnet). */
export async function readReceipts(cfg: NetworkConfig["hedera"], limit = 100): Promise<MirrorMessage[]> {
  const res = await fetch(`${cfg.mirrorUrl}/api/v1/topics/${cfg.hcsTopicId}/messages?order=desc&limit=${limit}`);
  if (!res.ok) throw new Error(`mirror read failed (${res.status})`);
  const body = (await res.json()) as { messages: { sequence_number: number; consensus_timestamp: string; message: string }[] };
  return body.messages.map((m) => ({
    sequence: m.sequence_number,
    consensusTimestamp: m.consensus_timestamp,
    receipt: JSON.parse(Buffer.from(m.message, "base64").toString("utf8")),
  }));
}
