import "../env.js";
import { identityFromEnv, loadNetworkConfig } from "../config.js";
import { connectCosigner } from "../integrations/index.js";
import { logger } from "../util/log.js";
import { startCosigner } from "./cosigner.js";

// Standalone cosigning verifier: `npm run cosigner`. Its key must be one of the vault's
// verifiers. It holds its own 0G credits and re-checks every slash the lead asks it to sign.

const deps = connectCosigner(loadNetworkConfig(), identityFromEnv());
const port = Number(process.env.COSIGNER_PORT || 4510);
const { url, cosigner } = await startCosigner(deps, port);
const info = await deps.vault.info();
if (!info.verifiers.includes(cosigner.address)) logger("cosigner")(`warning: ${cosigner.address} is not one of the vault's verifiers, so its signatures won't count`);
logger("cosigner")(`listening on ${url}`, { address: cosigner.address, network: deps.cfg.network, quorum: `${info.threshold} of ${info.verifiers.length}` });
