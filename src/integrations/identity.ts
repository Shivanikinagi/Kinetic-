// HCS-14 Universal Agent IDs. Every KINETIC agent (verifier, buyer, each provider) has a
// UAID derived from its public profile: the SHA-384 of the canonical profile, base58, plus
// routing parameters. Anyone can recompute it from the profile, so a provider can't claim
// another provider's identity or reputation.
//
// The UAID module is imported on its own: loading the whole standards SDK takes over a
// minute, while this file needs only canonicalisation, hashing and base58. The SDK version
// is pinned in package.json because the chunk name is not a public export.
// @ts-expect-error untyped deep import of the HCS-14 UAID module
import { createUaid, parseHcs14Did } from "../../node_modules/@hashgraphonline/standards-sdk/dist/es/standards-sdk.es56.js";

export interface AgentProfile {
  registry: string;
  name: string;
  version: string;
  protocol: string;
  /** CAIP-10 account the agent acts from: hedera:testnet:0.0.x, or eip155:<chain>:0x… on the devnet. */
  nativeId: string;
  /** HCS-11 capability codes. */
  skills: number[];
}

export type AgentRole = "verifier" | "buyer" | "provider";

// HCS-11 AIAgentCapability codes: TEXT_GENERATION 0, SUMMARIZATION_EXTRACTION 6,
// TRANSACTION_ANALYTICS 10, FRAUD_DETECTION 15, MULTI_AGENT_COORDINATION 16, WORKFLOW_AUTOMATION 18.
const SKILLS: Record<AgentRole, number[]> = { provider: [0, 6], verifier: [10, 15], buyer: [16, 18] };

export function agentProfile(opts: { role: AgentRole; name: string; network: "devnet" | "testnet"; hederaAccountId?: string; evmAddress: string }): AgentProfile {
  return {
    registry: "kinetic",
    name: opts.name,
    version: "1.0.0",
    protocol: "x402",
    nativeId: opts.network === "testnet" && opts.hederaAccountId ? `hedera:testnet:${opts.hederaAccountId}` : `eip155:296:${opts.evmAddress.toLowerCase()}`,
    skills: SKILLS[opts.role],
  };
}

/** uaid:aid:<base58 sha384>;uid=<evm address>;registry=kinetic;nativeId=… */
export async function uaidFor(profile: AgentProfile, evmAddress: string): Promise<string> {
  return (await createUaid(profile, { uid: evmAddress.toLowerCase() })) as string;
}

/** True when `uaid` is exactly what `profile` and `evmAddress` produce. */
export async function verifyUaid(uaid: string, profile: AgentProfile, evmAddress: string): Promise<boolean> {
  try {
    return (await uaidFor(profile, evmAddress)) === uaid;
  } catch {
    return false;
  }
}

/**
 * The queryable part of a UAID, "uaid:aid:<hash>". Arkiv string attributes are capped at
 * 128 bytes and a full UAID with routing parameters is longer, so entities keep this key as
 * an attribute and the full UAID in their payload.
 */
export const uaidKey = (uaid: string) => uaid.split(";")[0];

export function parseUaid(uaid: string): { method: string; id: string; params: Record<string, string> } {
  return parseHcs14Did(uaid);
}
