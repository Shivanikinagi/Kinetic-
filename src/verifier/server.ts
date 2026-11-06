import "../env.js";
import { identityFromEnv, loadNetworkConfig } from "../config.js";
import { connect } from "../integrations/index.js";
import { logger } from "../util/log.js";
import { startVerifier } from "./service.js";

// Standalone verifier agent: `npm run verifier`. Holds the 0G credits, the HCS submit key and
// one of the vault's verifier keys. Set VERIFIER_COSIGNERS to the other verifiers' cosigner URLs.

const svc = connect(loadNetworkConfig(), identityFromEnv());
const port = Number(process.env.VERIFIER_PORT || 4500);
const { url } = await startVerifier(svc, port);
logger("verifier")(`listening on ${url}`, { address: svc.address, network: svc.cfg.network, topic: svc.cfg.hedera.hcsTopicId });
