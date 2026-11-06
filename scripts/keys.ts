import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Generates one secp256k1 key per role. The same key is the role's Hedera ECDSA account,
// its Arkiv owner wallet and its vault address.

for (const role of ["verifier", "buyer", "provider"]) {
  const key = generatePrivateKey();
  console.log(`${role.padEnd(9)} KINETIC_PRIVATE_KEY=${key}`);
  console.log(`${"".padEnd(9)} EVM address ${privateKeyToAccount(key).address}`);
}
console.log(`
Next, for each role on testnet:
  1. Hedera: create an ECDSA account for the key at https://portal.hedera.com and fund it with testnet HBAR;
     put its id in HEDERA_ACCOUNT_ID.
  2. Arkiv: fund the EVM address from the Arkiv testnet faucet (see https://docs.arkiv.network).`);
