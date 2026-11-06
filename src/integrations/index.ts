import type { LocalAccount } from "viem";
import type { Identity, NetworkConfig } from "../config.js";
import { accountOf } from "../util/sign.js";
import { ArkivDevnetStore, ArkivSdkStore, type ArkivStore } from "./arkiv.js";
import { DevnetReceiptLog, HederaReceiptLog, type ReceiptLog } from "./hcs.js";
import { SwarmClient } from "./swarm.js";
import { stateFile } from "../util/state.js";
import { DevnetBondVault, EvmBondVault, type BondVault } from "./vault.js";
import { DevnetPaymentSigner, HederaPaymentSigner, type PaymentSigner } from "./x402.js";
import { ZeroGClient } from "./zerog.js";
import { zeroGDirectory } from "./zerog-compute.js";
import { DevnetZgStorage, ZgStorageClient, type ZgStorage } from "./zg-storage.js";
import { loadGoldSets, plantingPool } from "../verifier/known.js";

export interface Services {
  cfg: NetworkConfig;
  identity: Identity;
  account: LocalAccount;
  /** EVM address, lower-case. The role's identity on Arkiv and in the vault. */
  address: string;
  /** Hedera account id on testnet, EVM address on devnet. Where x402 payments land. */
  payTo: string;
  arkiv: ArkivStore;
  vault: BondVault;
  swarm: SwarmClient;
  receipts: () => ReceiptLog;
  payer: () => PaymentSigner;
  zerog: () => ZeroGClient;
  /** 0G Storage for model weights (made on first use: uploads need a funded 0G wallet). */
  zgStorage?: () => ZgStorage;
}

/** The 0G router client, checking canary TEE signers in the registry the router's providers are on (the emulator on devnet). */
function zeroGRouter(cfg: NetworkConfig): ZeroGClient {
  return new ZeroGClient(cfg.zerog, zeroGDirectory({ network: cfg.network, zgCompute: { rpcUrl: cfg.zerog.teeRpcUrl } }));
}

/**
 * What a cosigning verifier needs: it only reads (Arkiv, the vault, HCS, the mirror node,
 * Swarm), runs its own 0G reference runs and signs, so it needs no Hedera account.
 */
export function connectCosigner(cfg: NetworkConfig, identity: Identity) {
  const account = accountOf(identity.privateKey);
  const dev = cfg.network === "devnet";
  if (!dev && !cfg.hedera.vaultAddress) throw new Error("BOND_VAULT_ADDRESS is required on testnet");
  if (!cfg.zerog.apiKey || !cfg.zerog.model) throw new Error("ZEROG_API_KEY and ZEROG_MODEL are required: a cosigner re-runs failed canaries on 0G");
  return {
    cfg,
    account,
    arkiv: dev ? new ArkivDevnetStore(account, cfg.devnetUrl) : new ArkivSdkStore(account, cfg.arkiv),
    vault: dev ? new DevnetBondVault(account, cfg.devnetUrl) : new EvmBondVault(account, cfg.hedera.vaultAddress!, cfg.hedera),
    swarm: swarmClient(cfg),
    zerog: zeroGRouter(cfg),
    // The same labelled sets the lead plants from (GOLD_TASK/GOLD_SET and GOLD_DIR), to check known answers itself.
    gold: loadGoldSets().map(plantingPool),
    // Downloads only, to fetch weights a model card keeps on 0G Storage.
    zgStorage: () => (dev ? new DevnetZgStorage(cfg.devnetUrl) : new ZgStorageClient(cfg.zgStorage)),
  };
}

/** One install's roles share the postage stamp counters (same batch, same owner key). */
export function swarmClient(cfg: NetworkConfig): SwarmClient {
  const file = cfg.swarm.postageBatchId ? stateFile(cfg, `swarm-stamps-${cfg.swarm.postageBatchId.replace(/^0x/, "").slice(0, 16)}.json`) : undefined;
  return new SwarmClient(cfg.swarm, file ? { stampStateFile: file } : {});
}

/** Wires every integration for one role, for either devnet or Hedera/Arkiv/Swarm/0G testnets. */
export function connect(cfg: NetworkConfig, identity: Identity): Services {
  const account = accountOf(identity.privateKey);
  const address = account.address.toLowerCase();
  const dev = cfg.network === "devnet";

  if (!dev) {
    if (!identity.hederaAccountId) throw new Error("HEDERA_ACCOUNT_ID is required on testnet");
    if (!cfg.hedera.vaultAddress) throw new Error("BOND_VAULT_ADDRESS is required on testnet (npm run deploy:vault)");
  }

  return {
    cfg,
    identity,
    account,
    address,
    payTo: dev ? address : identity.hederaAccountId!,
    arkiv: dev ? new ArkivDevnetStore(account, cfg.devnetUrl) : new ArkivSdkStore(account, cfg.arkiv),
    vault: dev ? new DevnetBondVault(account, cfg.devnetUrl) : new EvmBondVault(account, cfg.hedera.vaultAddress!, cfg.hedera),
    swarm: swarmClient(cfg),
    receipts: () => {
      if (!cfg.hedera.hcsTopicId) throw new Error("HCS_TOPIC_ID is required (npm run create:topic)");
      return dev ? new DevnetReceiptLog(cfg.devnetUrl, cfg.hedera.hcsTopicId) : new HederaReceiptLog(identity, cfg.hedera.hcsTopicId);
    },
    payer: () => (dev ? new DevnetPaymentSigner(account, cfg.devnetUrl) : new HederaPaymentSigner(identity, cfg.hedera.mirrorUrl)),
    zerog: () => {
      if (!cfg.zerog.apiKey || !cfg.zerog.model) throw new Error("ZEROG_API_KEY and ZEROG_MODEL are required for 0G reference runs");
      return zeroGRouter(cfg);
    },
    // Uploads pay 0G's storage fee from this role's key, on the 0G chain.
    zgStorage: () => (dev ? new DevnetZgStorage(cfg.devnetUrl) : new ZgStorageClient(cfg.zgStorage, identity.privateKey)),
  };
}
