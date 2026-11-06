import { encodeAbiParameters, keccak256, recoverMessageAddress, toBytes, type Hex, type LocalAccount } from "viem";

// Slash verdicts as KineticBondVault checks them. A slash names the job, the chunk and the
// result hash that tipped the provider over its failure limit, plus a hash of all the failed
// checks behind it, and it needs signatures from a quorum of the vault's verifiers. Each
// verifier signs the 32-byte digest with EIP-191 (personal_sign), as the contract recovers it.

export interface SlashVerdict {
  provider: string;
  buyer: string;
  jobId: string;
  /** The chunk whose failed check reached the limit, and the result hash its provider signed. */
  chunk: number;
  resultHash: string;
  refundTinybar: bigint;
  /** canonicalJson of the evidence (HCS receipts and every failed check); hashed on-chain. */
  evidence: string;
}

/** Which vault and chain a signature is for, so it can't be replayed on another deployment. */
export interface VaultDomain {
  address: string;
  chainId: number;
}

export const VERDICT_TYPEHASH = keccak256(toBytes("KineticSlashVerdict(address provider,address buyer,bytes32 jobId,uint32 chunk,bytes32 resultHash,uint256 refund,bytes32 evidence)"));
export const RESOLUTION_TYPEHASH = keccak256(toBytes("KineticDisputeResolution(bytes32 slashId,bool upheld)"));

export const jobIdBytes32 = (jobId: string): Hex => keccak256(toBytes(jobId));
export const evidenceBytes32 = (evidence: string): Hex => keccak256(toBytes(evidence));

/** Result hashes are 64-hex sha256 digests; on-chain they are bytes32. */
export function resultHashBytes32(resultHash: string): Hex {
  const h = resultHash.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`result hash must be 32 bytes of hex, got ${resultHash}`);
  return `0x${h}`;
}

/** The vault's id for a slash: one per provider and job. */
export function slashIdOf(provider: string, jobId: string): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [provider as Hex, jobIdBytes32(jobId)]));
}

/** The verdict as the contract's Verdict struct. */
export function verdictArgs(v: SlashVerdict) {
  return {
    provider: v.provider as Hex,
    buyer: v.buyer as Hex,
    jobId: jobIdBytes32(v.jobId),
    chunk: v.chunk,
    resultHash: resultHashBytes32(v.resultHash),
    refund: v.refundTinybar,
    evidence: evidenceBytes32(v.evidence),
  };
}

export function verdictDigest(v: SlashVerdict, domain: VaultDomain): Hex {
  const a = verdictArgs(v);
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
        { type: "uint32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [VERDICT_TYPEHASH, BigInt(domain.chainId), domain.address as Hex, a.provider, a.buyer, a.jobId, a.chunk, a.resultHash, a.refund, a.evidence],
    ),
  );
}

export function resolutionDigest(slashId: Hex, upheld: boolean, domain: VaultDomain): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "bool" }],
      [RESOLUTION_TYPEHASH, BigInt(domain.chainId), domain.address as Hex, slashId, upheld],
    ),
  );
}

export function signDigest(account: LocalAccount, digest: Hex): Promise<Hex> {
  return account.signMessage({ message: { raw: digest } });
}

export async function digestSigner(digest: Hex, signature: Hex): Promise<string> {
  return (await recoverMessageAddress({ message: { raw: digest }, signature })).toLowerCase();
}

/**
 * Keeps the signatures that recover to distinct allowed signers, sorted by signer address as
 * the vault requires. `signers` lines up with `signatures`.
 */
export async function quorumSignatures(digest: Hex, signatures: Hex[], allowed: string[]): Promise<{ signatures: Hex[]; signers: string[] }> {
  const allow = new Set(allowed.map((a) => a.toLowerCase()));
  const bySigner = new Map<string, Hex>();
  for (const sig of signatures) {
    let signer: string;
    try {
      signer = await digestSigner(digest, sig);
    } catch {
      continue;
    }
    if (allow.has(signer) && !bySigner.has(signer)) bySigner.set(signer, sig);
  }
  const signers = [...bySigner.keys()].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  return { signers, signatures: signers.map((s) => bySigner.get(s)!) };
}
