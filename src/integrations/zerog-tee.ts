import { recoverMessageAddress, type Hex } from "viem";
import { sha256Hex } from "../util/crypto.js";
import { serviceKind, teeSignersOf, type ZeroGDirectory } from "./zerog-compute.js";

// Our own check of the TEE signature on a 0G router run (a canary's reference run), instead of
// the router's word for it (`x_0g_trace.tee_verified`). What we can and can't establish:
//
// - The 0G Compute provider that served the run is in x_0g_trace (and the X-Provider header).
//   Its service record is on 0G's inference serving contract on 0G MAINNET (chain 16661): the
//   router's providers are registered there, not on Galileo, so the lookup uses the mainnet RPC.
// - Its TEE signs every exchange and files the signature under the chat id (the ZG-Res-Key
//   header), served unauthenticated at GET {service url}/v1/proxy/signature/{chatId}?model=, by
//   the provider itself, not the router. We recover it as EIP-191 personal_sign and accept it only
//   if it recovers to a TEE signer registered on-chain (teeSignerAddress, or TargetTeeAddress when the LLM runs
//   in its own enclave), never the `signing_address` the endpoint reports.
// - What is signed: router-api.0g.ai seals every request to the provider's enclave (HPKE, the
//   0G Private Computer E2EE gateway; X-0G-E2EE: sealed), so the TEE signs
//   `zg-sig-v1/e2ee-ct:<H(aad,ct) request>:<H(aad,ct) response>`, hashes of the on-wire
//   ciphertext (0g-pc-e2ee protocol/SPEC.md §8). The ciphertext exists only between the gateway
//   and the enclave; we receive plaintext, so we cannot recompute the two hashes. The binding
//   to the content is checked by 0G's attested gateway, not by us. What our check does prove:
//   the provider's registered enclave signed a sealed exchange under this response's chat id.
// - A centralized (TeeTLS) provider's TEE also signs a routing proof naming the outside cloud and
//   its TLS certificate. On a sealed exchange it travels next to the signature, signed on its own:
//   it must be present, recover to the same signer, and carry the same two hashes (the broker's
//   own verifier contract, 0g-serving-broker ctrl/signing.go).

/** What a 0G provider's TEE signed for one chat, as stored in the Compute Passport. */
export interface CanaryTeeSignature {
  /** The exact text the TEE signed. Hashes only: of ciphertext when sealed. */
  signedText: string;
  /** sha256 of signedText, hex. */
  signedTextHash: string;
  /** EIP-191 personal_sign over signedText. */
  signature: string;
  /** The TEE signer registered on-chain for the provider, lower-case. */
  signer: string;
  /** The centralized routing proof: outside cloud and its TLS fingerprint, signed separately. */
  routingProof?: { text: string; signature: string };
}

/** Our verification of one canary's reference run, recorded per canary. */
export interface CanaryTee extends Partial<CanaryTeeSignature> {
  /** The trust mode the canary was served under ("private" = TeeML only). */
  trustMode: string;
  /** Set when the configured trust mode had no provider and the run fell back: never silent. */
  fallback?: string;
  /** 0G Compute provider that served it, lower-case, and how it serves the model. */
  provider: string;
  providerType?: "decentralized" | "centralized";
  providerIdentity?: string;
  /** The guarantee the provider gives: TeeML runs the model in the enclave, TeeTLS relays to an outside cloud. */
  guarantee: "TeeML" | "TeeTLS" | "unknown";
  chatId: string;
  /** The signed text's scheme, e.g. "zg-sig-v1/e2ee-ct" (sealed) or "legacy" (sha256(req):sha256(resp)). */
  scheme?: string;
  /** Our verification result. "verified": the on-chain signer signed this chat. */
  verification: "verified" | "invalid" | "unavailable";
  reason?: string;
  /** What the router itself said (only present when it says anything). */
  routerTeeVerified: boolean | null;
  /** 0G's charge for the run, from x_0g_trace.billing (USD micro). */
  costUsdMicro: number;
  /** The 0G chain the signer was looked up on. */
  chainId?: number;
}

const SEALED = new Set(["zg-sig-v1/e2ee-ct", "zg-sig-v1/e2ee-ct-stream"]);
const HEX64 = /^[0-9a-f]{64}$/;

/** The scheme and the two hash halves of a signed text, or why it can't be read. */
export function parseSignedText(text: string): { scheme: string; req: string; resp: string; rest: string[] } | { error: string } {
  const parts = text.split(":");
  const tagged = parts[0]!.startsWith("zg-sig-");
  const scheme = tagged ? parts[0]! : "legacy";
  const [req, resp, ...rest] = tagged ? parts.slice(1) : parts;
  if (!req || !resp || !HEX64.test(req) || !HEX64.test(resp)) return { error: "the signed text is not two sha256 hashes" };
  if (tagged && !SEALED.has(scheme) && scheme !== "zg-sig-v1/plain") return { error: `unknown signature scheme ${scheme}` };
  return { scheme, req, resp, rest };
}

const recovers = async (text: string, signature: string, signer: string) => {
  try {
    return (await recoverMessageAddress({ message: text, signature: signature as Hex })).toLowerCase() === signer.toLowerCase();
  } catch {
    return false;
  }
};

/**
 * Checks a stored TEE signature without any network access: the text hash, the EIP-191 signature
 * against the recorded signer, the scheme, and for a centralized provider the routing proof. The
 * signer itself being the one registered on-chain is the online half (checkCanaryTeeOnline).
 */
export async function checkTeeSignature(sig: CanaryTeeSignature, providerType?: "decentralized" | "centralized"): Promise<{ ok: boolean; scheme?: string; reason?: string }> {
  if (sha256Hex(sig.signedText) !== sig.signedTextHash) return { ok: false, reason: "signedTextHash is not the hash of the signed text" };
  const parsed = parseSignedText(sig.signedText);
  if ("error" in parsed) return { ok: false, reason: parsed.error };
  if (!(await recovers(sig.signedText, sig.signature, sig.signer))) return { ok: false, scheme: parsed.scheme, reason: "the signature does not recover to the TEE signer" };
  if (providerType === "centralized") {
    if (SEALED.has(parsed.scheme)) {
      // A sealed exchange with a centralized provider must carry its routing proof, for the same exchange.
      const rp = sig.routingProof;
      if (!rp) return { ok: false, scheme: parsed.scheme, reason: "centralized provider, but no routing proof with the signature" };
      const [rq, rs] = rp.text.split(":");
      if (rq !== parsed.req || rs !== parsed.resp) return { ok: false, scheme: parsed.scheme, reason: "the routing proof is for a different exchange" };
      if (!(await recovers(rp.text, rp.signature, sig.signer))) return { ok: false, scheme: parsed.scheme, reason: "the routing proof is not signed by the TEE signer" };
    } else if (parsed.rest[0] !== "centralized") return { ok: false, scheme: parsed.scheme, reason: "centralized provider, but the signed text has no routing proof" };
  }
  return { ok: true, scheme: parsed.scheme };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetches and checks the TEE signature for one router run: looks the provider up in the 0G
 * serving contract, fetches the signature from the provider's own endpoint and checks it.
 * Never throws: a failure is a result ("invalid" or "unavailable") with its reason.
 */
export async function verifyRouterRun(
  directory: ZeroGDirectory,
  run: { provider: string; chatId: string; trustMode: string; routerTeeVerified: boolean | null; costUsdMicro: number; fallback?: string },
  opts: { retries?: number; chainId?: number } = {},
): Promise<CanaryTee> {
  const base: CanaryTee = {
    trustMode: run.trustMode,
    ...(run.fallback ? { fallback: run.fallback } : {}),
    provider: run.provider.toLowerCase(),
    guarantee: "unknown",
    chatId: run.chatId,
    verification: "unavailable",
    routerTeeVerified: run.routerTeeVerified,
    costUsdMicro: run.costUsdMicro,
    ...(opts.chainId ? { chainId: opts.chainId } : {}),
  };
  const unavailable = (reason: string): CanaryTee => ({ ...base, verification: "unavailable", reason });
  if (!/^0x[0-9a-f]{40}$/.test(base.provider)) return unavailable("the router named no 0G Compute provider");
  if (!run.chatId) return unavailable("the response carried no chat id (ZG-Res-Key)");
  let svc;
  try {
    svc = await directory.get(base.provider);
  } catch (err) {
    return unavailable(`could not read the 0G serving contract: ${(err as Error).message}`);
  }
  if (!svc) return unavailable(`0G provider ${base.provider} is not in the 0G serving contract`);
  const kind = serviceKind(svc);
  Object.assign(base, kind, { guarantee: kind.providerType === "centralized" ? "TeeTLS" : svc.verifiability === "TeeML" ? "TeeML" : "unknown" });
  if (!svc.teeSignerAcknowledged) return unavailable("the provider's TEE signer is not acknowledged on-chain");
  const signers = teeSignersOf(svc);
  if (!signers.length) return unavailable("the provider registers no TEE signer");
  base.signer = signers[0];

  const url = `${svc.url.replace(/\/$/, "")}/v1/proxy/signature/${encodeURIComponent(run.chatId)}?model=${encodeURIComponent(svc.model)}`;
  // The provider caches the signature just as it sends the response: allow it a moment.
  let res: Response | undefined;
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    if (res?.ok || attempt >= retries) break;
    await sleep(700 * (attempt + 1));
  }
  if (!res) return unavailable("could not reach the provider's signature endpoint");
  if (res.status === 404) return { ...base, verification: "invalid", reason: "the provider has no TEE signature for this chat id" };
  if (!res.ok) return unavailable(`the provider's signature endpoint answered ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { text?: string; signature?: string; routing_proof?: { text?: string; signature?: string } };
  if (!body.text || !body.signature) return { ...base, verification: "invalid", reason: "malformed TEE signature" };
  // Of the signers registered on-chain, the one this signature recovers to (never the endpoint's own claim).
  let signer = signers[0]!;
  for (const s of signers) if (await recovers(body.text, body.signature, s)) signer = s;
  const sig: CanaryTeeSignature = {
    signedText: body.text,
    signedTextHash: sha256Hex(body.text),
    signature: body.signature,
    signer,
    ...(body.routing_proof?.text && body.routing_proof.signature ? { routingProof: { text: body.routing_proof.text, signature: body.routing_proof.signature } } : {}),
  };
  const check = await checkTeeSignature(sig, kind.providerType);
  // A multi-upstream relay registers one identity on-chain; the signed routing proof names the one that served.
  const proof = (sig.routingProof?.text ?? sig.signedText).split(":");
  const at = proof.indexOf("centralized");
  if (check.ok && kind.providerType === "centralized" && at >= 0 && proof[at + 1]) base.providerIdentity = proof[at + 1];
  return { ...base, ...sig, ...(check.scheme ? { scheme: check.scheme } : {}), verification: check.ok ? "verified" : "invalid", ...(check.reason ? { reason: check.reason } : {}) };
}

/**
 * Re-checks a recorded canary signature offline: the signature, and that the recorded result
 * ("verified") follows from it. Returns null when there's nothing to check (no signature was recorded).
 */
export async function recheckCanaryTee(tee: CanaryTee): Promise<{ ok: boolean; reason?: string } | null> {
  if (!tee.signedText || !tee.signature || !tee.signer || !tee.signedTextHash) {
    return tee.verification === "verified" ? { ok: false, reason: "marked verified without a signature" } : null;
  }
  const check = await checkTeeSignature(tee as CanaryTeeSignature, tee.providerType);
  if (check.ok !== (tee.verification === "verified")) return { ok: false, reason: check.ok ? "a valid signature is recorded as not verified" : check.reason };
  if (tee.trustMode === "private" && tee.verification === "verified" && tee.guarantee !== "TeeML") return { ok: false, reason: `served in private mode by a ${tee.guarantee} provider` };
  return { ok: true };
}

/** The online half: the recorded signer is the one the 0G serving contract registers for the provider. */
export async function checkCanarySigner(directory: ZeroGDirectory, tee: CanaryTee): Promise<{ ok: boolean; reason?: string }> {
  const svc = await directory.get(tee.provider);
  if (!svc) return { ok: false, reason: `0G provider ${tee.provider} is not registered` };
  const signers = teeSignersOf(svc);
  return tee.signer && signers.includes(tee.signer.toLowerCase()) ? { ok: true } : { ok: false, reason: `registered signer is ${signers.join(" or ") || "none"}` };
}
