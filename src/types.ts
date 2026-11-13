// Shared domain types for KINETIC.

export type TaskKind = "classify" | "extract" | "tag";

export interface LabelSpec {
  name: string;
  /** Comma-separated keywords, used in the prompt. */
  hint?: string;
}

export interface FieldSpec {
  name: string;
  hint?: string;
  /** Optional regex used by the heuristic model. */
  pattern?: string;
}

export interface TaskSpec {
  kind: TaskKind;
  instructions: string;
  labels?: LabelSpec[];
  fields?: FieldSpec[];
}

export interface Item {
  id: string;
  text: string;
}

export interface ItemOutput {
  id: string;
  label?: string;
  tags?: string[];
  fields?: Record<string, string | null>;
}

export interface ChunkResult {
  items: ItemOutput[];
}

/** Wire body the buyer agent sends to a provider's x402-protected chunk endpoint. */
export interface ChunkRequest {
  jobId: string;
  idx: number;
  task: TaskSpec;
  /**
   * The chunk's items, AES-256-GCM sealed under this chunk's key (base64). It travels only inside
   * this paid request, so nobody but the provider holding the key can read it.
   */
  data: string;
  /**
   * This chunk's AES-256 key, wrapped to the provider's public key and bound to this job, chunk
   * and provider (see src/util/wrap.ts). Only that provider can open it.
   */
  wrappedKey?: string;
  /** Base64 AES-256 key for this chunk only, unwrapped: only for a provider with no encryption key, and only if the buyer allows it. */
  chunkKey?: string;
  /** The listed model to run (its key), for a model job. A provider that doesn't serve it refuses before payment. */
  model?: string;
}

/**
 * Where a chunk actually ran, when the provider calls one 0G Compute provider directly
 * (PROVIDER_BACKEND=0g-compute) instead of the 0G router.
 */
export interface ZeroGExecution {
  /** On-chain address of the 0G Compute provider that served the request, lower-case. */
  zgProvider: string;
  endpoint: string;
  model: string;
  /** The 0G chat id (ZG-Res-Key) the 0G provider's TEE signature is filed under. */
  chatId: string;
  /** The 0G provider's registered verifiability, e.g. "TeeML"; empty when it declares none. */
  verifiability: string;
  /**
   * "decentralized": the model runs on the 0G provider's own TEE node. "centralized": the 0G
   * provider's TEE relays to an outside cloud (named in providerIdentity), so no 0G GPU ran it.
   */
  providerType: "decentralized" | "centralized";
  providerIdentity?: string;
  /** sha256 of the request body the KINETIC provider sent (not covered by the TEE signature). */
  requestHash?: string;
  /** sha256 of the exact response bytes the 0G provider returned; the result is parsed from them. */
  responseHash: string;
  /** The KINETIC provider's own check. The verifier checks again and its answer is the one that counts. */
  attestation: AttestationStatus;
  latencyMs: number;
  at: number;
}

/**
 * Whether a 0G provider's TEE attested a result. Never collapsed into a yes/no.
 * - verified: its TEE signature recovers to the signer registered on-chain, and the response it
 *   signed is byte-for-byte the one the result was parsed from.
 * - unavailable: there is nothing to check (no verifiability, signer not acknowledged on-chain,
 *   or the signature could not be fetched). Not a pass.
 * - invalid: a signature exists and is wrong, missing for a verifiable service, or covers a different response.
 */
export type AttestationStatus = "verified" | "unavailable" | "invalid";

/**
 * How long the provider's model took on a chunk, and the token counts its model server reported
 * (OpenAI `usage`). Provider-reported and NOT covered by the signature: shown as a speed figure
 * only, never used to accept, pay or slash.
 */
export interface ChunkUsage {
  /** Wall-clock time of the model call at the provider. */
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

/** What a provider returns for a completed chunk. */
export interface ChunkResponse {
  /** Speed of the model call, provider-reported and unsigned. */
  usage?: ChunkUsage;
  jobId: string;
  idx: number;
  result: ChunkResult;
  resultHash: string;
  /** Provider EVM address that signed the result. */
  provider: string;
  /** EIP-191 signature over canonicalJson({jobId, idx, resultHash}), plus executionHash when `execution` is set and `model` when it is. */
  signature: string;
  /** The listed model the chunk ran on (its key), for a model job. Covered by the signature. */
  model?: string;
  /** Set when the chunk ran on a 0G Compute provider directly. Covered by the signature. */
  execution?: ZeroGExecution;
  /** Base64 of the exact response bytes from the 0G provider (hash in execution.responseHash), so the verifier can bind result, response and attestation. */
  rawResponse?: string;
}

/** Provider offer, as stored on Arkiv. */
export interface Offer {
  key?: string;
  /** Provider's EVM address (Arkiv owner, vault bond holder, result signer). */
  provider: string;
  /** x402 payTo: a Hedera account id on testnet, the EVM address on devnet. */
  payTo: string;
  name: string;
  endpoint: string;
  tasks: TaskKind[];
  gpu: string;
  priceTinybar: bigint;
  bondTinybar: bigint;
  expiresAt?: number;
  /** HCS-14 Universal Agent ID, checked against the profile the offer publishes. */
  uaid?: string;
  /** Model backend the provider declares (e.g. "openai:qwen2.5:3b-instruct"). Not proven. */
  backend?: string;
  /** The provider's secp256k1 public key (compressed), from its offer: chunk keys are wrapped to it. */
  encKey?: string;
  /** Set when the provider declares itself an adversarial test provider, and how it cheats. */
  adversarial?: string;
  /** The 0G Compute provider this provider runs on, when it calls one directly. Lower-case. */
  zgProvider?: string;
  /** Whether that 0G provider's responses can be TEE-attested, read by the buyer from the 0G chain. */
  attestable?: boolean;
  /** Whether that 0G provider runs the model itself or relays to an outside cloud, from the 0G chain. */
  providerType?: "decentralized" | "centralized";
  /** That 0G service's registered verifiability (TeeML, SPML, …), from the 0G chain. */
  verifiability?: string;
  providerIdentity?: string;
  /** How the buyer agent ranked this offer, from price, track record and speed. */
  rank?: ProviderRank;
  /** Listed models the provider serves (their keys), with weights it checked against their passports. */
  models?: string[];
  /** How the provider isolates the models it runs, as it declares it (e.g. "docker:no-network"). Not proven. */
  sandbox?: string;
}

/** Each part is 0..1, higher is better. `score` is their weighted sum for the chosen strategy. */
export interface ProviderRank {
  score: number;
  price: number;
  /** (pass + 1) / (pass + fail + 2) over the verifier's checks, so a newcomer starts at 0.5. */
  reliability: number;
  speed: number;
  /** Checks behind `reliability`. */
  checks: number;
  latencyMs?: number;
  /**
   * From the verifier's unexpired check entities on Arkiv: "active" with a pass in the last six
   * hours, "stale" with only older ones, "unproven" with none. Absent when there are none at all.
   */
  proof?: "active" | "stale" | "unproven";
}

export interface Payment {
  /** Hedera transaction id returned by the facilitator's settle step. */
  tx: string;
  amountTinybar: bigint;
  payTo: string;
  network: string;
}

export type Verdict = "accepted" | "canary_pass" | "canary_fail" | "rejected";

export interface SlashOutcome {
  provider: string;
  buyer: string;
  jobId: string;
  /** Paid back to the buyer once executed; until then, what the verdict asks for (capped at the bond). */
  refundTinybar: bigint;
  /** The transaction that moved the refund once settled; until then, the proposal. */
  vaultTx: string;
  receiptSeq?: number;
  /** The vault's id for the slash (absent on slashes from before quorum slashing). */
  slashId?: string;
  proposeTx?: string;
  /** Where the slash stands in the vault: open through its dispute window, then settled. */
  status?: "proposed" | "disputed" | "executed" | "overturned" | "cancelled";
  /** The verifiers whose signatures carried the slash. */
  signers?: string[];
  /** The rest of the provider's bond, burned when the slash executed. */
  burnedTinybar?: bigint;
  /** When the vault's own scheduled call (HIP-1215) executes the slash, unix seconds, if it took one. */
  scheduledAt?: number;
}

export const isSettled = (s: Pick<SlashOutcome, "status">) => s.status === undefined || s.status === "executed" || s.status === "overturned" || s.status === "cancelled";

export interface ResultVerdict {
  verdict: Verdict;
  reason?: string;
  /** `kind` "known": scored against planted known answers; "model": against the 0G reference model. */
  canary?: { agreement: number; pass: boolean; kind?: "known" | "model" };
  /** The known answers planted in this chunk, and how many it got right. */
  known?: { items: number; correct: number; pass: boolean };
  /**
   * High assurance only. "awaiting": run another independent copy. "mismatch": the copies so far
   * disagree, run one more. "unresolved": three or more and still no two agree. "matched": two
   * agreed; `winner` is the provider whose copy is kept.
   */
  redundancy?: { state: "awaiting" | "mismatch" | "unresolved" | "matched"; copies: number; winner?: string; agreement?: number; outvoted?: string[] };
  provider: { status: "ok" | "slashed"; failures: number; window: number };
  slash?: SlashOutcome;
  /** The verifier's own check of the 0G execution record, when the result carries one. */
  execution?: ExecutionCheck;
}

/** The verifier's verdict on one 0G execution record. `reason` explains anything short of verified. */
export interface ExecutionCheck {
  zgProvider: string;
  chatId: string;
  model: string;
  providerType: ZeroGExecution["providerType"];
  providerIdentity?: string;
  /** The verifiability the 0G service registered on-chain (TeeML, SPML, …), as the verifier read it. */
  verifiability?: string;
  attestation: AttestationStatus;
  reason?: string;
}

export const TINYBARS_PER_HBAR = 100_000_000n;

/** What x402 payments settle in: HBAR ("0.0.0") or an HTS token. */
export interface PaymentAsset {
  id: string;
  symbol: string;
  decimals: number;
}

export const HBAR: PaymentAsset = { id: "0.0.0", symbol: "HBAR", decimals: 8 };
export const isHbar = (asset: PaymentAsset) => asset.id === "0.0.0";

/** 1000n KUSD (8 decimals) → "0.00001 KUSD"; HBAR keeps the ℏ sign. */
export function formatAmount(units: bigint, asset: PaymentAsset): string {
  if (isHbar(asset)) return formatHbar(units);
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const scale = 10n ** BigInt(asset.decimals);
  const frac = (abs % scale).toString().padStart(asset.decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${abs / scale}${frac ? "." + frac : ""} ${asset.symbol}`;
}

export function formatHbar(tinybar: bigint): string {
  const negative = tinybar < 0n;
  const abs = negative ? -tinybar : tinybar;
  const whole = abs / TINYBARS_PER_HBAR;
  const frac = (abs % TINYBARS_PER_HBAR).toString().padStart(8, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? "." + frac : ""} ℏ`;
}
