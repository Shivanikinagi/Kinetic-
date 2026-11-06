import { mkdirSync, writeFileSync } from "node:fs";
import { passportJsonSchema } from "../src/agent/passport-schema.js";

// Writes the Compute Passport v2 format as JSON Schema, so a third party can check a passport's
// shape with any JSON Schema validator. `npm run passport:verify` checks the rest: signatures,
// commitments, and the records on HCS, the mirror node and the vault.

mkdirSync("docs", { recursive: true });
writeFileSync("docs/compute-passport.schema.json", JSON.stringify(passportJsonSchema(), null, 2) + "\n");
console.log("wrote docs/compute-passport.schema.json");
