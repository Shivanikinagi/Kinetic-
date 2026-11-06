import { createZGComputeNetworkBroker, createZGComputeNetworkReadOnlyBroker, type ZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";
import { JsonRpcProvider, Wallet } from "ethers";
import { verifyMessage, type Hex } from "viem";
import type { NetworkConfig } from "../config.js";
import type { ModelBackend } from "../provider/backend.js";
import { buildMessages, parseModelOutput } from "../tasks/prompt.js";
import type { AttestationStatus, ChunkResult, Item, TaskSpec, ZeroGExecution } from "../types.js";
import { sha256Hex } from "../util/crypto.js";

// 0G Compute, called directly: a KINETIC provider is bound to one 0G Compute provider (an
// on-chain address in the inference serving contract), sends each chunk to that provider's
// own endpoint, and returns the chat id its TEE signed together with the exact response bytes.
// Anyone can then fetch that signature from the 0G provider, check it against the TEE signer
// registered on-chain, and check that the response it covers is the one the result came from,
// without trusting the KINETIC provider that relayed it. The alternative is the 0G router
// (zerog.ts), where the router picks the node and KINETIC never sees which.
//
// What the TEE signs (0g-serving-broker, api/inference/internal/ctrl/signing.go):
//   decentralized: sha256(requestBody):sha256(responseBody)
//   centralized:   sha256(requestBody):sha256(responseBody):providerType:providerIdentity:tlsCertFingerprint
// responseBody is the exact bytes delivered to the client, so the second field binds the answer.
// The request field is not checked: the broker may rewrite the request before hashing it.

/** A 0G Compute service as registered on-chain. */
export interface ZeroGService {
  /** Lower-case. */
  provider: string;
  serviceType: string;
  url: string;
  model: string;
  verifiability: string;
  teeSignerAddress: string;
  teeSignerAcknowledged: boolean;
  additionalInfo: string;
  /** Per-token prices in neuron (1e-18 0G), when the registry reports them. */
  inputPrice?: bigint;
  outputPrice?: bigint;
}

/** Where 0G Compute services are looked up: the on-chain registry, or the devnet stand-in. */
export interface ZeroGDirectory {
  list(): Promise<ZeroGService[]>;
  get(provider: string): Promise<ZeroGService | undefined>;
}

const VERIFIABLE = new Set(["TeeML", "OpML", "ZKML"]);

function infoOf(svc: ZeroGService): { ProviderType?: string; ProviderIdentity?: string; TargetSeparated?: boolean; TargetTeeAddress?: string } | undefined {
  try {
    return JSON.parse(svc.additionalInfo || "{}");
  } catch {
    return undefined;
  }
}

/** Whether the model runs on the 0G provider's own TEE node, or its TEE relays to an outside cloud. */
export function serviceKind(svc: ZeroGService): { providerType: ZeroGExecution["providerType"]; providerIdentity?: string } {
  const info = infoOf(svc);
  return info?.ProviderType === "centralized" ? { providerType: "centralized", providerIdentity: info.ProviderIdentity || undefined } : { providerType: "decentralized" };
}

/** The address that signs this service's responses: the LLM's own TEE when it runs separately. */
export function teeSignerOf(svc: ZeroGService): string | undefined {
  const info = infoOf(svc);
  if (!info) return undefined;
  if (info.TargetSeparated === true && info.ProviderType !== "centralized" && info.TargetTeeAddress) return info.TargetTeeAddress;
  return svc.teeSignerAddress || undefined;
}

/**
 * Every TEE signer a service registers on-chain, preferred first. A provider whose LLM runs in a
 * separate enclave (TargetSeparated) registers both: the target signs its own exchanges, while a
 * sealed router exchange (zg-sig-v1/e2ee-ct) is signed by the service's teeSignerAddress (seen live
 * on glm-5.3, 2026-11-05). A signature counts only if it recovers to one of these.
 */
export function teeSignersOf(svc: ZeroGService): string[] {
  return [...new Set([teeSignerOf(svc), svc.teeSignerAddress].filter((a): a is string => !!a).map((a) => a.toLowerCase()))];
}

/** Whether a service's responses can be attested at all: a declared verifiability and a signer acknowledged on-chain. */
export function attestable(svc: ZeroGService): boolean {
  return VERIFIABLE.has(svc.verifiability) && svc.teeSignerAcknowledged && !!teeSignerOf(svc);
}

export interface TeeCheck {
  attestation: AttestationStatus;
  reason?: string;
  /** The text the TEE signed, when there was one. */
  signedText?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Checks one chat's TEE attestation, independently of whoever relayed it: fetches the signature
 * from the 0G provider, recovers it against the signer registered on-chain, and checks the
 * response it covers is `responseHash`. Without `responseHash` a valid signature is not enough
 * to call the result verified.
 */
export async function attest(svc: ZeroGService, chatId: string, responseHash?: string, opts: { retries?: number } = {}): Promise<TeeCheck> {
  if (!VERIFIABLE.has(svc.verifiability)) return { attestation: "unavailable", reason: "the 0G service declares no verifiability" };
  if (!svc.teeSignerAcknowledged) return { attestation: "unavailable", reason: "the 0G service's TEE signer is not acknowledged on-chain" };
  const signer = teeSignerOf(svc);
  if (!signer) return { attestation: "unavailable", reason: "the 0G service names no TEE signer" };
  const url = `${svc.url.replace(/\/$/, "")}/v1/proxy/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(svc.model)}`;
  // The signature is cached just after the response is sent: give it a moment before calling it missing.
  const retries = opts.retries ?? 3;
  let res: Response | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      if (attempt >= retries) return { attestation: "unavailable", reason: `could not reach the 0G provider for the signature: ${(err as Error).message}` };
    }
    if (res && res.status !== 404 && res.ok) break;
    if (attempt >= retries) break;
    await sleep(500 * (attempt + 1));
  }
  // A verifiable service with no signature for this chat id never signed it.
  if (res!.status === 404) return { attestation: "invalid", reason: "the 0G provider has no TEE signature for this chat id" };
  if (!res!.ok) return { attestation: "unavailable", reason: `0G provider answered ${res!.status} for the signature` };
  const body = (await res!.json()) as { text?: string; signature?: string };
  if (!body.text || !body.signature) return { attestation: "invalid", reason: "malformed TEE signature" };
  const ok = await verifyMessage({ address: signer as Hex, message: body.text, signature: body.signature as Hex }).catch(() => false);
  if (!ok) return { attestation: "invalid", reason: "TEE signature does not recover to the signer registered on-chain", signedText: body.text };
  if (!responseHash) return { attestation: "unavailable", reason: "signature valid, but no response to bind it to", signedText: body.text };
  const signedResponse = body.text.split(":")[1];
  if (signedResponse !== responseHash) return { attestation: "invalid", reason: "the TEE signed a different response than the one returned", signedText: body.text };
  return { attestation: "verified", signedText: body.text };
}

/** What a direct backend needs from 0G Compute: the SDK broker on testnet, plain HTTP on devnet. */
export interface ZeroGComputeClient {
  /** The provider's on-chain registration. */
  service(provider: string): Promise<ZeroGService>;
  /** The provider's proxy endpoint and model. */
  metadata(provider: string): Promise<{ endpoint: string; model: string }>;
  /** Per-request auth headers (the broker signs them and tops the sub-account up as needed). */
  headers(provider: string): Promise<Record<string, string>>;
  /** After a response: report usage so the broker's fee accounting stays right. */
  settle(provider: string, chatId: string, usage?: unknown): Promise<void>;
}

class CachedDirectory implements ZeroGDirectory {
  private cache?: { at: number; services: Promise<ZeroGService[]> };
  constructor(private readonly load: () => Promise<ZeroGService[]>) {}
  list() {
    if (!this.cache || Date.now() - this.cache.at > 60_000) {
      const services = this.load();
      services.catch(() => (this.cache = undefined));
      this.cache = { at: Date.now(), services };
    }
    return this.cache.services;
  }
  async get(provider: string) {
    const p = provider.toLowerCase();
    return (await this.list()).find((s) => s.provider === p);
  }
}

const directories = new Map<string, ZeroGDirectory>();

/** The 0G Compute service registry for this network, shared per RPC URL. */
export function zeroGDirectory(cfg: Pick<NetworkConfig, "network" | "zgCompute">): ZeroGDirectory {
  const rpc = cfg.zgCompute.rpcUrl;
  let dir = directories.get(rpc);
  if (dir) return dir;
  dir =
    cfg.network === "devnet"
      ? new CachedDirectory(async () => {
          const res = await fetch(`${rpc}/services`);
          if (!res.ok) throw new Error(`devnet 0G Compute directory answered ${res.status}`);
          return (await res.json()) as ZeroGService[];
        })
      : new CachedDirectory(async () => {
          const broker = await createZGComputeNetworkReadOnlyBroker(rpc);
          // The serving contract returns at most 50 services per call.
          const services: Awaited<ReturnType<typeof broker.inference.listService>> = [];
          for (let offset = 0; offset < 1000; offset += 50) {
            const page = await broker.inference.listService(offset, 50, true);
            services.push(...page);
            if (page.length < 50) break;
          }
          return services.map((s) => ({
            provider: s.provider.toLowerCase(),
            serviceType: s.serviceType,
            url: s.url,
            model: s.model,
            verifiability: s.verifiability,
            teeSignerAddress: s.teeSignerAddress,
            teeSignerAcknowledged: s.teeSignerAcknowledged,
            additionalInfo: s.additionalInfo,
            inputPrice: s.inputPrice,
            outputPrice: s.outputPrice,
          }));
        });
  directories.set(rpc, dir);
  return dir;
}

/** The SDK's broker for one funded 0G wallet. One per key and chain, so funding txs share a nonce sequence. */
const brokers = new Map<string, Promise<ZGComputeNetworkBroker>>();
export function zeroGBroker(rpcUrl: string, privateKey: string): Promise<ZGComputeNetworkBroker> {
  const id = `${rpcUrl}|${privateKey}`;
  let b = brokers.get(id);
  if (!b) {
    b = createZGComputeNetworkBroker(new Wallet(privateKey, new JsonRpcProvider(rpcUrl)));
    b.catch(() => brokers.delete(id));
    brokers.set(id, b);
  }
  return b;
}

async function registered(directory: ZeroGDirectory, provider: string) {
  const svc = await directory.get(provider);
  if (!svc) throw new Error(`0G provider ${provider} is not registered on the 0G chain`);
  return svc;
}

class BrokerClient implements ZeroGComputeClient {
  constructor(
    private readonly broker: () => Promise<ZGComputeNetworkBroker>,
    private readonly directory: ZeroGDirectory,
  ) {}
  service(provider: string) {
    return registered(this.directory, provider);
  }
  async metadata(provider: string) {
    return (await this.broker()).inference.getServiceMetadata(provider);
  }
  async headers(provider: string) {
    const h = await (await this.broker()).inference.getRequestHeaders(provider);
    return Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
  }
  async settle(provider: string, chatId: string, usage?: unknown) {
    // processResponse also checks the signature, but without binding it to the response: attest() does that.
    await (await this.broker()).inference.processResponse(provider, chatId, usage ? JSON.stringify(usage) : undefined);
  }
}

/** Devnet: same wire format as a 0G provider's proxy, no ledger. */
class DevnetClient implements ZeroGComputeClient {
  constructor(private readonly directory: ZeroGDirectory) {}
  service(provider: string) {
    return registered(this.directory, provider);
  }
  async metadata(provider: string) {
    const svc = await this.service(provider);
    return { endpoint: `${svc.url}/v1/proxy`, model: svc.model };
  }
  async headers() {
    return {};
  }
  async settle() {}
}

export function zeroGComputeClient(cfg: NetworkConfig, privateKey?: string): ZeroGComputeClient {
  const directory = zeroGDirectory(cfg);
  if (cfg.network === "devnet") return new DevnetClient(directory);
  if (!privateKey) throw new Error("PROVIDER_BACKEND=0g-compute needs ZG_PRIVATE_KEY (a 0G wallet with a funded compute ledger)");
  return new BrokerClient(() => zeroGBroker(cfg.zgCompute.rpcUrl, privateKey), directory);
}

/** The 0G Compute provider failed or misbehaved: not this KINETIC provider's model output. */
export class UpstreamError extends Error {
  /** Sent to the buyer, so it reroutes to an independent 0G provider rather than retrying this one. */
  readonly code = "upstream_failed";
  constructor(
    readonly zgProvider: string,
    message: string,
  ) {
    super(`0G provider ${zgProvider}: ${message}`);
  }
}

export interface DirectRun {
  result: ChunkResult;
  execution: ZeroGExecution;
  /** Base64 of the exact response bytes. */
  rawResponse: string;
}

/** The result a raw 0G chat completion response stands for, so anyone holding the bytes can recompute it. */
export function resultFromResponse(task: TaskSpec, items: Item[], raw: Uint8Array): ChunkResult {
  const body = JSON.parse(Buffer.from(raw).toString("utf8")) as { choices?: { message?: { content?: string } }[] };
  return parseModelOutput(task, items, body.choices?.[0]?.message?.content ?? "");
}

/**
 * Runs every chunk on one 0G Compute provider, chosen by its on-chain address. A failed call
 * or a response its TEE didn't sign throws, so the buyer is not charged and reroutes the chunk.
 */
export class ZeroGComputeBackend implements ModelBackend {
  readonly zgProvider: string;
  private model = "";

  constructor(
    private readonly client: ZeroGComputeClient,
    zgProvider: string,
    private readonly timeoutMs = 120_000,
  ) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(zgProvider)) throw new Error(`ZG_PROVIDER_ADDRESS must be a 0G provider address, got "${zgProvider}"`);
    this.zgProvider = zgProvider.toLowerCase();
  }

  /** Resolves the model the 0G provider serves, so the offer can declare it. */
  async init(): Promise<this> {
    this.model = (await this.client.metadata(this.zgProvider)).model;
    return this;
  }

  get name() {
    return `0g-compute:${this.model || "unknown"}`;
  }

  async run(task: TaskSpec, items: Item[]): Promise<ChunkResult> {
    return (await this.runWithEvidence(task, items)).result;
  }

  async runWithEvidence(task: TaskSpec, items: Item[]): Promise<DirectRun> {
    const fail = (message: string) => new UpstreamError(this.zgProvider, message);
    const lookup = async () => Promise.all([this.client.service(this.zgProvider), this.client.metadata(this.zgProvider), this.client.headers(this.zgProvider)]);
    const [svc, { endpoint, model }, headers] = await lookup().catch((err: Error) => {
      throw fail(`could not prepare the request: ${err.message}`);
    });
    const started = Date.now();
    let res: Response;
    const request = JSON.stringify({ model, messages: buildMessages(task, items), temperature: 0 });
    try {
      res = await fetch(`${endpoint.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: request,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw fail(`unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) throw fail(`answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
    // Keep the exact bytes: the TEE signed their hash, and the result must be parsed from them.
    const raw = new Uint8Array(await res.arrayBuffer());
    let body: { id?: string; usage?: unknown };
    let result: ChunkResult;
    try {
      body = JSON.parse(Buffer.from(raw).toString("utf8"));
      result = resultFromResponse(task, items, raw);
    } catch {
      throw fail("returned a response that is not JSON");
    }
    const chatId = res.headers.get("zg-res-key") || body.id || "";
    if (!chatId) throw fail("returned no chat id, so its TEE signature can't be checked");
    await this.client.settle(this.zgProvider, chatId, body.usage).catch(() => undefined);
    const responseHash = sha256Hex(raw);
    const tee = await attest(svc, chatId, responseHash);
    // Never pass on a response the 0G provider's TEE contradicts. "unavailable" goes through, labelled.
    if (tee.attestation === "invalid") throw fail(`TEE attestation invalid: ${tee.reason}`);
    return {
      result,
      rawResponse: Buffer.from(raw).toString("base64"),
      execution: {
        zgProvider: this.zgProvider,
        endpoint,
        model,
        chatId,
        verifiability: svc.verifiability,
        ...serviceKind(svc),
        // What was sent: the broker may rewrite a request before its TEE hashes it, so this is not checked against the signature.
        requestHash: sha256Hex(request),
        responseHash,
        attestation: tee.attestation,
        latencyMs: Date.now() - started,
        at: started,
      },
    };
  }
}
