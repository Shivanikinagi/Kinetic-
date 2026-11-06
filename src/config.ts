import type { Hex } from "viem";
import type { CanaryPolicy } from "./core/policy.js";

export type NetworkName = "devnet" | "testnet";

export interface NetworkConfig {
  network: NetworkName;
  /** Base URL of the devnet emulator, used only by the automated tests. */
  devnetUrl: string;
  /**
   * Payments are in HBAR (asset "0.0.0", amounts in tinybar), the same asset as bonds, so a
   * slash refunds exactly what the buyer paid, with no exchange rate.
   */
  /**
   * facilitatorUrls: every x402 facilitator, in order of preference. Each quote goes to the first
   * healthy one, and settlement to the one that quoted (the payment is signed for its fee payer).
   * facilitatorUrl is the first of them.
   */
  x402: { network: string; facilitatorUrl: string; facilitatorUrls: string[]; asset: "0.0.0"; symbol: "HBAR"; decimals: 8 };
  hedera: {
    mirrorUrl: string;
    hcsTopicId: string;
    jsonRpcUrl: string;
    vaultAddress?: Hex;
    /**
     * What a slash proposal pays the vault to execute the slash itself when its dispute window
     * closes (HIP-1215 scheduled call), tinybar (VAULT_SCHEDULE_FEE_TINYBAR). Unset: the call's
     * gas limit at the current gas price, plus a margin. 0: never schedule.
     */
    vaultScheduleFeeTinybar?: bigint;
  };
  /**
   * Arkiv's DB-chain. apiKey: an access key (hub.arkiv.network), sent as X-API-KEY; keys are per
   * network. chainId and explorerUrl follow from the RPC (default Rabdi) unless set.
   */
  arkiv: { rpcUrl: string; apiKey?: string; chainId: number; explorerUrl: string };
  /**
   * Swarm via a Bee API. encrypt: Bee-side encryption (128-hex refs that carry their own key),
   * refused on a public gateway. postageBatchId: a paid batch; through a public gateway it only
   * works with stampKey (the batch owner's key, stamps signed client-side) and postageDepth.
   * redundancy: erasure-coding level (swarm-redundancy-level) for passports. feeds: publish one
   * feed per model whose latest entry is its newest Model Passport.
   */
  swarm: { beeUrl: string; gatewayUrl: string; postageBatchId?: string; encrypt: boolean; stampKey?: Hex; postageDepth?: number; redundancy: number; feeds: boolean };
  /**
   * 0G router. trustMode is for ordinary calls; canaryTrustMode for canary reference runs
   * ("private": TeeML only), with canaryFallback ("verified", or "none") used, and recorded,
   * when no TeeML provider is free. teeRpcUrl is the 0G chain the router's providers are
   * registered on (mainnet), where the verifier looks up each canary's TEE signer.
   */
  zerog: { baseUrl: string; apiKey: string; model: string; trustMode: string; canaryTrustMode: string; canaryFallback: string; teeRpcUrl: string };
  /**
   * 0G Compute network, for providers that call one 0G provider directly and for the verifier
   * checking their TEE signatures. rpcUrl is the 0G chain; on devnet the emulator stands in.
   */
  zgCompute: { rpcUrl: string };
  /**
   * 0G Storage, where model weights can live (built for large files): the 0G chain the storage fee
   * is paid on (Galileo testnet) and the indexer that finds storage nodes.
   */
  zgStorage: { rpcUrl: string; indexerUrl: string };
  /**
   * ERC-8004 Trustless Agents on 0G Chain (Galileo by default): the Identity and Reputation
   * registries 0G deployed. enabled: off on devnet, and with ERC8004=off.
   */
  erc8004: { enabled: boolean; rpcUrl: string; chainId: number; identityRegistry: Hex; reputationRegistry: Hex; explorerUrl: string };
  /**
   * plantKnown: plant a known-answer item in every chunk when the verifier has labelled examples
   * for the task (KNOWN_ANSWERS, default on). modelSlashes: let disagreement with the 0G reference
   * model count toward slashing (CANARY_MODEL_SLASHES, default off: it only fails the chunk).
   * spotChecks: chunks re-run on 0G after a job closes, picked by a Hedera PRNG seed the verifier
   * draws in the vault after the canary reveal (SPOT_CHECKS, default 1; 0 on devnet).
   */
  policy: CanaryPolicy & { canaryRate: number; minCanaries: number; plantKnown: boolean; modelSlashes: boolean; spotChecks: number };
  /** What the verifier charges per chunk it verifies, paid over x402 when a job registers. */
  verifierFeePerChunkTinybar: bigint;
  /**
   * The other verifiers the lead asks to co-sign a slash (VERIFIER_COSIGNERS, comma-separated
   * URLs), and how long finalizing a job waits for its slashes' dispute windows to close.
   */
  quorum: { cosigners: string[]; settleWaitSeconds: number };
  /**
   * The model hub: the benchmark accuracy a model needs to be listed (MODEL_MIN_ACCURACY), how many
   * labelled examples it is scored on (MODEL_BENCHMARK_ITEMS), the x402 listing fee the creator
   * pays the verifier for the review (MODEL_LISTING_FEE_TINYBAR), and the most weights bytes a
   * verifier downloads to check (MODEL_MAX_DOWNLOAD_MB).
   */
  models: { minAccuracy: number; benchmarkItems: number; listingFeeTinybar: bigint; maxDownloadBytes: number };
  /**
   * Where a role keeps state that must survive a restart: the verifier's open jobs and the
   * payment headers each gate already accepted. Off on devnet unless KINETIC_STATE_DIR is set.
   */
  stateDir?: string;
}

/** Public Swarm gateway. It accepts small uploads without a postage batch. */
export const SWARM_PUBLIC_GATEWAY = "https://api.gateway.ethswarm.org";

/**
 * Arkiv's testnets, each with its own access keys. Rabdi is the current one, and the default.
 * Tiramisu runs Arkiv's earlier protocol, which @arkiv-network/sdk 1.0 no longer speaks: it is
 * kept so chain ids and explorer links of entities written there still resolve.
 */
export const ARKIV_NETWORKS = {
  rabdi: { rpcUrl: "https://rpc.rabdi.db-chain.testnet.arkiv.network", chainId: 7794095, explorerUrl: "https://rabdi.explorer.arkiv.network" },
  tiramisu: { rpcUrl: "https://rpc.tiramisu.db-chain.testnet.arkiv.network", chainId: 7738577, explorerUrl: "https://tiramisu.explorer.arkiv.network" },
} as const;

function arkivNetwork(env: Record<string, string | undefined>): NetworkConfig["arkiv"] {
  const rpcUrl = env.ARKIV_RPC_URL || ARKIV_NETWORKS.rabdi.rpcUrl;
  const known = Object.values(ARKIV_NETWORKS).find((n) => rpcUrl.includes(new URL(n.rpcUrl).hostname.split(".")[1]!));
  return {
    rpcUrl,
    ...(env.ARKIV_API_KEY ? { apiKey: env.ARKIV_API_KEY } : {}),
    chainId: Number(env.ARKIV_CHAIN_ID) || known?.chainId || ARKIV_NETWORKS.rabdi.chainId,
    explorerUrl: env.ARKIV_EXPLORER_URL || known?.explorerUrl || ARKIV_NETWORKS.rabdi.explorerUrl,
  };
}

/** One role's keys. The same secp256k1 key is its Hedera ECDSA account, Arkiv owner and vault address. */
export interface Identity {
  privateKey: Hex;
  hederaAccountId?: string;
}

type Env = Record<string, string | undefined>;

/**
 * Hedera testnet x402 facilitators (docs.hedera.com/solutions/ai/x402/facilitators), each with
 * /supported, /verify and /settle and its own fee payer: x402.org (0.0.9185802), Blocky402
 * (0.0.7162784) and Launa (0.0.9839454).
 */
export const TESTNET_FACILITATORS = ["https://x402.org/facilitator", "https://api.testnet.blocky402.com", "https://testnet.facilitator.launa.dev"];

/**
 * X402_FACILITATOR_URLS (comma-separated) is the whole list, in order. Without it,
 * X402_FACILITATOR_URL goes first and the defaults follow as fallbacks.
 */
function facilitators(env: Env, defaults: string[]): { facilitatorUrl: string; facilitatorUrls: string[] } {
  const clean = (u: string) => u.trim().replace(/\/$/, "");
  const listed = (env.X402_FACILITATOR_URLS || "").split(",").map(clean).filter(Boolean);
  const urls = [...new Set(listed.length ? listed : [...(env.X402_FACILITATOR_URL ? [clean(env.X402_FACILITATOR_URL)] : []), ...defaults])];
  return { facilitatorUrl: urls[0]!, facilitatorUrls: urls };
}

const num =(v: string | undefined, fallback: number) => (v === undefined || v === "" ? fallback : Number(v));

export function loadNetworkConfig(env: Env = process.env): NetworkConfig {
  const network = (env.KINETIC_NETWORK || "testnet") as NetworkName;
  if (network !== "devnet" && network !== "testnet") throw new Error(`KINETIC_NETWORK must be testnet, got ${network}`);
  // The devnet emulator is the automated tests' harness. KINETIC itself runs only on the real networks.
  if (network === "devnet" && !process.env.VITEST) throw new Error("KINETIC_NETWORK=devnet is only for the automated tests; KINETIC runs on testnet");
  const devnetUrl = env.DEVNET_URL || "http://localhost:4400";
  const dev = network === "devnet";

  return {
    network,
    devnetUrl,
    x402: {
      network: dev ? "kinetic:devnet" : "hedera:testnet",
      ...facilitators(env, dev ? [`${devnetUrl}/facilitator`] : TESTNET_FACILITATORS),
      asset: "0.0.0",
      symbol: "HBAR",
      decimals: 8,
    },
    hedera: {
      mirrorUrl: env.HEDERA_MIRROR_URL || (dev ? `${devnetUrl}/mirror` : "https://testnet.mirrornode.hedera.com"),
      hcsTopicId: env.HCS_TOPIC_ID || (dev ? "0.0.5005" : ""),
      jsonRpcUrl: env.HEDERA_JSON_RPC_URL || "https://testnet.hashio.io/api",
      vaultAddress: env.BOND_VAULT_ADDRESS as Hex | undefined,
      ...(env.VAULT_SCHEDULE_FEE_TINYBAR ? { vaultScheduleFeeTinybar: BigInt(env.VAULT_SCHEDULE_FEE_TINYBAR) } : {}),
    },
    arkiv: arkivNetwork(env),
    swarm: {
      beeUrl: env.BEE_URL || (dev ? `${devnetUrl}/bee` : SWARM_PUBLIC_GATEWAY),
      gatewayUrl: env.SWARM_GATEWAY_URL || env.BEE_URL || (dev ? `${devnetUrl}/bee` : SWARM_PUBLIC_GATEWAY),
      postageBatchId: env.BEE_POSTAGE_BATCH_ID || undefined,
      // Off by default: chunks are already AES-GCM sealed, and a 128-hex ref must never reach a public gateway.
      encrypt: env.SWARM_ENCRYPT === "true",
      ...(env.SWARM_STAMP_KEY ? { stampKey: (env.SWARM_STAMP_KEY.startsWith("0x") ? env.SWARM_STAMP_KEY : `0x${env.SWARM_STAMP_KEY}`) as Hex } : {}),
      ...(env.BEE_POSTAGE_DEPTH ? { postageDepth: Number(env.BEE_POSTAGE_DEPTH) } : {}),
      redundancy: env.SWARM_REDUNDANCY_LEVEL ? Math.max(0, Math.min(4, Math.trunc(Number(env.SWARM_REDUNDANCY_LEVEL)) || 0)) : 2,
      feeds: (env.SWARM_FEEDS ?? "true") !== "false",
    },
    zerog: {
      baseUrl: env.ZEROG_BASE_URL || (dev ? `${devnetUrl}/0g/v1` : "https://router-api.0g.ai/v1"),
      apiKey: env.ZEROG_API_KEY || (dev ? "devnet" : ""),
      // Must be a model with `verifiability` set in GET /v1/models. glm-5.3 is TeeML: it runs on
      // 0G Compute nodes, and differs from the providers' 0G model so canaries compare two models.
      model: env.ZEROG_MODEL || (dev ? "devnet-reference" : "glm-5.3"),
      trustMode: env.ZEROG_TRUST_MODE || "verified",
      canaryTrustMode: env.ZEROG_CANARY_TRUST_MODE || "private",
      canaryFallback: env.ZEROG_CANARY_FALLBACK || "verified",
      // The router's providers are on 0G mainnet (chain 16661), not Galileo.
      teeRpcUrl: env.ZEROG_TEE_RPC_URL || (dev ? `${devnetUrl}/0gc` : "https://evmrpc.0g.ai"),
    },
    zgCompute: { rpcUrl: env.ZG_RPC_URL || (dev ? `${devnetUrl}/0gc` : "https://evmrpc-testnet.0g.ai") },
    erc8004: {
      enabled: !dev && env.ERC8004 !== "off",
      rpcUrl: env.ERC8004_RPC_URL || env.ZG_STORAGE_RPC_URL || "https://evmrpc-testnet.0g.ai",
      chainId: num(env.ERC8004_CHAIN_ID, 16602),
      identityRegistry: (env.ERC8004_IDENTITY_REGISTRY || "0x8004A818BFB912233c491871b3d84c89A494BD9e") as Hex,
      reputationRegistry: (env.ERC8004_REPUTATION_REGISTRY || "0x8004B663056A597Dffe9eCcC1965A193B7388713") as Hex,
      explorerUrl: env.ERC8004_EXPLORER_URL || "https://chainscan-galileo.0g.ai",
    },
    zgStorage: {
      rpcUrl: env.ZG_STORAGE_RPC_URL || env.ZG_RPC_URL || "https://evmrpc-testnet.0g.ai",
      indexerUrl: env.ZG_STORAGE_INDEXER_URL || (dev ? `${devnetUrl}/zgs` : "https://indexer-storage-testnet-turbo.0g.ai"),
    },
    policy: {
      canaryRate: num(env.CANARY_RATE, 0.25),
      minCanaries: num(env.CANARY_MIN, 1),
      window: num(env.CANARY_WINDOW, 10),
      failLimit: num(env.CANARY_FAIL_LIMIT, 3),
      minAgreement: num(env.CANARY_MIN_AGREEMENT, 0.8),
      plantKnown: (env.KNOWN_ANSWERS || "true") === "true",
      // Chunks re-run on 0G after each job, picked by a Hedera PRNG seed drawn then (core/spot.ts).
      spotChecks: num(env.SPOT_CHECKS, dev ? 0 : 1),
      modelSlashes: env.CANARY_MODEL_SLASHES === "true",
    },
    verifierFeePerChunkTinybar: BigInt(env.VERIFIER_FEE_PER_CHUNK_TINYBAR || 10_000),
    quorum: {
      cosigners: (env.VERIFIER_COSIGNERS || "")
        .split(",")
        .map((u) => u.trim().replace(/\/$/, ""))
        .filter(Boolean),
      settleWaitSeconds: num(env.SLASH_SETTLE_WAIT, 120),
    },
    models: {
      minAccuracy: num(env.MODEL_MIN_ACCURACY, 0.7),
      benchmarkItems: num(env.MODEL_BENCHMARK_ITEMS, 12),
      listingFeeTinybar: BigInt(env.MODEL_LISTING_FEE_TINYBAR || 1_000_000),
      maxDownloadBytes: num(env.MODEL_MAX_DOWNLOAD_MB, 512) * 1024 * 1024,
    },
    stateDir: env.KINETIC_STATE_DIR || (dev ? undefined : ".kinetic/testnet/state"),
  };
}

export function identityFromEnv(env: Env = process.env): Identity {
  const privateKey = env.KINETIC_PRIVATE_KEY;
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("KINETIC_PRIVATE_KEY must be a 0x-prefixed 32-byte hex secp256k1 key (run `npm run keys`)");
  }
  return { privateKey: privateKey as Hex, hederaAccountId: env.HEDERA_ACCOUNT_ID };
}
