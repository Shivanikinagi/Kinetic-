import { recoverMessageAddress, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalJson, jsonReplacer, sha256Hex } from "./crypto.js";

export function accountOf(privateKey: Hex): LocalAccount {
  return privateKeyToAccount(privateKey);
}

/** Hash of a 0G execution record, so the provider's result signature also covers where it ran. */
export function executionHash(execution: unknown | undefined): string | undefined {
  return execution === undefined ? undefined : sha256Hex(canonicalJson(execution));
}

// `model`: the key of the listed model the chunk ran on, when the buyer asked for one. Signed, so a
// provider that answers a model job commits to which model produced the answer.
const resultMessage = (jobId: string, idx: number, resultHash: string, execHash?: string, model?: string) =>
  canonicalJson({ jobId, idx, resultHash, ...(execHash ? { executionHash: execHash } : {}), ...(model ? { model } : {}) });

/** Provider signature over a chunk result, so a buyer cannot forge bad results to frame a provider. */
export async function signResult(account: LocalAccount, jobId: string, idx: number, resultHash: string, execHash?: string, model?: string): Promise<Hex> {
  return account.signMessage({ message: resultMessage(jobId, idx, resultHash, execHash, model) });
}

export async function recoverResultSigner(jobId: string, idx: number, resultHash: string, signature: Hex, execHash?: string, model?: string): Promise<string> {
  return (await recoverMessageAddress({ message: resultMessage(jobId, idx, resultHash, execHash, model), signature })).toLowerCase();
}

// Signed JSON requests to the devnet emulator, so ownership rules (who can patch an Arkiv
// entity, who can slash) are enforced there the same way the real networks enforce them.

const MAX_SKEW_MS = 5 * 60_000;

/** A signed JSON POST request, ready for fetch() or payFetch(). */
export async function signedRequest(account: LocalAccount, body: unknown): Promise<RequestInit & { headers: Record<string, string>; body: string }> {
  const text = JSON.stringify(body, jsonReplacer);
  const ts = Date.now().toString();
  const signature = await account.signMessage({ message: `${ts}:${sha256Hex(text)}` });
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kinetic-signer": account.address,
      "x-kinetic-ts": ts,
      "x-kinetic-signature": signature,
    },
    body: text,
  };
}

export async function signedPost(account: LocalAccount, url: string, body: unknown): Promise<Response> {
  return fetch(url, await signedRequest(account, body));
}

export async function verifySignedRequest(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<string> {
  const signer = String(headers["x-kinetic-signer"] ?? "");
  const ts = String(headers["x-kinetic-ts"] ?? "");
  const signature = String(headers["x-kinetic-signature"] ?? "") as Hex;
  if (!signer || !ts || !signature) throw new Error("missing signature headers");
  if (Math.abs(Date.now() - Number(ts)) > MAX_SKEW_MS) throw new Error("stale signature");
  const recovered = await recoverMessageAddress({ message: `${ts}:${sha256Hex(rawBody)}`, signature });
  if (recovered.toLowerCase() !== signer.toLowerCase()) throw new Error("bad signature");
  return recovered.toLowerCase();
}
