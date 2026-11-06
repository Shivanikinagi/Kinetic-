import type { NetworkConfig } from "../config.js";
import { attest, resultFromResponse, serviceKind, zeroGDirectory, type ZeroGService } from "../integrations/zerog-compute.js";
import type { AttestationStatus, ChunkResponse, ExecutionCheck, TaskSpec } from "../types.js";
import { canonicalJson, sha256Hex } from "../util/crypto.js";

// Checks a verifier runs on a provider's result that any other verifier can repeat from the
// same evidence, so a cosigner can confirm a failure before it signs a slash.

/** One failed check against a provider, with the signed result it failed on. */
export interface FailureEvidence {
  /** "known": missed a planted known answer. "canary": disagreed with the 0G reference (slashes only with CANARY_MODEL_SLASHES). */
  kind: "known" | "canary" | "format" | "execution";
  idx: number;
  response: ChunkResponse;
  payTx: string;
}

/** Everything a cosigner needs to re-check a slash on its own. */
export interface SlashPacket {
  /** The verdict to sign, refund as a decimal string. */
  verdict: { provider: string; buyer: string; jobId: string; chunk: number; resultHash: string; refundTinybar: string; evidence: string };
  /** The job as the buyer registered it, job key included so canary chunks can be re-run. */
  registration: { jobId: string; buyer: string; task: TaskSpec; chunks: { idx: number; swarmRef: string; itemIds?: string[] }[]; jobKey: string };
  /** The canary set and salt, checked against the commitment on HCS. */
  canaries: { indices: number[]; salt: string };
  /** Where known answers were planted, checked against the job's `known` commitment on HCS. */
  known?: { placements: { idx: number; ids: string[] }[]; salt: string };
  failures: FailureEvidence[];
  /** Every x402 payment this provider received in the job, for the refund ceiling. */
  payments: string[];
  /** Where the provider is paid (a Hedera account on testnet). */
  payTo: string;
}

/** What a slash's `evidence` field holds: the HCS receipts and every failed check, by result hash. */
export function evidenceOf(topic: string, jobId: string, provider: string, receipts: number[], failures: FailureEvidence[]): string {
  return canonicalJson({ topic, job: jobId, provider, receipts, failures: failures.map((f) => ({ k: f.kind, i: f.idx, r: f.response.resultHash })) });
}

/**
 * The 0G execution record on a result, checked independently of the provider:
 * - it names the 0G Compute provider the offer declares;
 * - the response bytes hash to the record's responseHash, and the result is what they say;
 * - the 0G provider's TEE signed that same responseHash, recovering to the signer on the 0G chain.
 * Anything that contradicts the record is "invalid" and rejected. Nothing to check is
 * "unavailable": accepted, and labelled as such, never as verified. `isReplay` lets the
 * verifier refuse a 0G chat id it already credited to another result.
 */
export async function checkExecutionRecord(
  cfg: NetworkConfig,
  task: TaskSpec,
  itemIds: string[] | undefined,
  declared: string | undefined,
  response: ChunkResponse,
  isReplay: (chatKey: string) => boolean = () => false,
): Promise<{ execution?: ExecutionCheck; problem?: string; chatKey?: string }> {
  const exec = response.execution;
  if (!exec) return declared ? { problem: `declares 0G provider ${declared} but returned no 0G execution record` } : {};
  const zgProvider = exec.zgProvider.toLowerCase();
  // The on-chain registration, not the record, says what kind of service it is.
  let svc: ZeroGService | undefined;
  let registryError: string | undefined;
  try {
    svc = await zeroGDirectory(cfg).get(zgProvider);
  } catch (err) {
    registryError = (err as Error).message;
  }
  const kind = svc ? { ...serviceKind(svc), verifiability: svc.verifiability } : { providerType: exec.providerType, providerIdentity: exec.providerIdentity };
  const check = (attestation: AttestationStatus, reason?: string): ExecutionCheck => ({ zgProvider, chatId: exec.chatId, model: exec.model, ...kind, attestation, ...(reason ? { reason } : {}) });
  const invalid = (reason: string) => ({ execution: check("invalid", reason), problem: `0G execution invalid: ${reason}` });

  if (declared && zgProvider !== declared) return invalid(`ran on 0G provider ${zgProvider}, not the declared ${declared}`);
  if (!exec.chatId) return invalid("no chat id");
  const chatKey = `${zgProvider}|${exec.chatId}`;
  if (isReplay(chatKey)) return invalid("chat id already used for another result");

  // The result must be exactly what the 0G provider returned.
  if (!response.rawResponse) return invalid("no response bytes, so the result can't be tied to the 0G run");
  const raw = Buffer.from(response.rawResponse, "base64");
  if (sha256Hex(raw) !== exec.responseHash) return invalid("response bytes don't match the signed execution record");
  if (itemIds) {
    let recomputed: string;
    try {
      recomputed = canonicalJson(resultFromResponse(task, itemIds.map((id) => ({ id, text: "" })), raw));
    } catch {
      return invalid("response bytes are not a chat completion");
    }
    if (recomputed !== canonicalJson(response.result)) return invalid("the result differs from what the 0G provider returned");
  }

  if (registryError) return { execution: check("unavailable", `0G service registry unreachable: ${registryError}`) };
  if (!svc) return invalid(`0G provider ${zgProvider} is not registered on the 0G chain`);
  const tee = await attest(svc, exec.chatId, exec.responseHash);
  if (tee.attestation === "invalid") return invalid(tee.reason ?? "TEE attestation invalid");
  return { execution: check(tee.attestation, tee.reason), chatKey };
}
