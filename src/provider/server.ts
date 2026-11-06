import "../env.js";
import { identityFromEnv, loadNetworkConfig } from "../config.js";
import { connect } from "../integrations/index.js";
import { startProvider } from "./node.js";
import { providerOptionsFromEnv } from "./options.js";

// Standalone provider node: `npm run provider`. See .env.example for the PROVIDER_* settings.

const cfg = loadNetworkConfig();
const svc = connect(cfg, identityFromEnv());

const provider = await startProvider(await providerOptionsFromEnv(process.env, cfg, svc), svc);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await provider.close();
    process.exit(0);
  });
}
