import type { NetworkConfig } from "../config.js";
import type { Services } from "../integrations/index.js";
import { prepareModels } from "./models.js";
import type { TaskKind } from "../types.js";
import { backendForEnv, parseBehavior } from "./backend.js";
import type { ProviderOptions } from "./node.js";

/**
 * A provider node's settings from its PROVIDER_* variables (see .env.example). With `svc`, the
 * listed models in PROVIDER_MODELS are checked against their Model Passports and served.
 */
export async function providerOptionsFromEnv(env: Record<string, string | undefined>, cfg: NetworkConfig, svc?: Services): Promise<ProviderOptions> {
  const backend = await backendForEnv(env, cfg);
  const refs = (env.PROVIDER_MODELS || "").split(",").map((m) => m.trim()).filter(Boolean);
  const models = svc && refs.length ? await prepareModels(svc, { refs, mainBackend: backend, env }) : undefined;
  return {
    name: env.PROVIDER_NAME || "provider",
    port: Number(env.PROVIDER_PORT || 5101),
    publicUrl: env.PROVIDER_PUBLIC_URL || undefined,
    gpu: env.PROVIDER_GPU || "unknown",
    tasks: (env.PROVIDER_TASKS || "classify,extract,tag").split(",").map((t) => t.trim()) as TaskKind[],
    priceTinybar: BigInt(env.PROVIDER_PRICE_TINYBAR || 100_000),
    bondTinybar: BigInt(env.PROVIDER_BOND_TINYBAR || 100_000_000),
    backend,
    behavior: parseBehavior(env.PROVIDER_BEHAVIOR),
    hcs10Inbound: env.HOL_INBOUND_TOPIC_ID || undefined,
    ...(models ? { models } : {}),
    ...(env.PROVIDER_SANDBOX ? { sandbox: env.PROVIDER_SANDBOX } : {}),
  };
}
