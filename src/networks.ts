import type { Hex } from "viem";

// The three values every buyer and provider on a KINETIC network shares, published by whoever
// runs its verifiers. TESTNET is the deployment behind the README's live runs.

export interface NetworkPreset {
  /** HCS topic the verifier posts receipts to. */
  hcsTopicId: string;
  /** KineticBondVault: bonds, slashes and refunds. */
  vaultAddress: Hex;
  /** The lead verifier buyers register jobs with. Ask the operator for its public URL. */
  verifierUrl: string;
}

export const TESTNET: NetworkPreset = {
  hcsTopicId: "0.0.11212792",
  vaultAddress: "0x11d76cec886b06d5f8e7f4e7d9a5fa2c9808b294",
  verifierUrl: "http://localhost:4500",
};
