import { z } from "zod";

// The Compute Passport v2 format, as one schema: `verifyPassport` checks passports against it,
// and `npm run passport:schema` writes it out as JSON Schema (docs/compute-passport.schema.json)
// for anyone who wants to check passports without this code. Amounts are decimal strings in
// the payment asset's smallest unit (tinybar for HBAR); hashes are lower-case hex.

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const amount = z.string().regex(/^\d+$/);
const attestation = z.enum(["verified", "unavailable", "invalid"]);
const guarantee = z.enum(["TeeML", "TeeTLS", "SPML", "OpML", "ZKML", "none"]);

const itemOutput = z.object({
  id: z.string(),
  label: z.string().optional(),
  tags: z.array(z.string()).optional(),
  fields: z.record(z.string(), z.string().nullable()).optional(),
});

const execution = z.object({
  zgProvider: z.string(),
  endpoint: z.string(),
  model: z.string(),
  chatId: z.string(),
  verifiability: z.string(),
  providerType: z.enum(["decentralized", "centralized"]),
  providerIdentity: z.string().optional(),
  requestHash: hex64.optional(),
  responseHash: hex64,
  attestation,
  latencyMs: z.number(),
  at: z.number(),
});

const authenticity = z
  .object({
    method: z.enum(["0g-direct", "0g-router", "self-hosted", "unknown"]),
    model: z.object({ declared: z.string().optional(), served: z.string().optional(), hash: hex64.nullable() }),
    node: z.string().optional(),
    guarantee,
    attestation: z.enum(["verified", "unavailable", "invalid", "none"]),
    requestHash: hex64.optional(),
    responseHash: hex64.optional(),
  })
  .describe("Where and how the chunk ran, and what was attested. Says nothing about whether the answer is right.");

const correctness = z
  .object({
    methods: z.array(z.enum(["signature", "format", "known-answers", "redundant-agreement", "model-agreement"])),
    level: z.enum(["ground-truth", "redundant-agreement", "model-agreement", "format-only"]),
  })
  .describe("How the answer was checked, and the strongest check it passed. Says nothing about which model ran.");

const work = z.object({
  idx: z.number().int().nonnegative(),
  items: z.number().int().nonnegative(),
  provider: address,
  resultHash: hex64,
  signature: z.string(),
  payTx: z.string().optional(),
  amount,
  check: z.enum(["verified", "format"]),
  execution: execution.optional(),
  attestation: attestation.optional(),
  attestationReason: z.string().optional(),
  planted: z.array(z.object({ at: z.number().int().nonnegative(), item: itemOutput })).optional(),
  known: z.object({ items: z.number().int(), correct: z.number().int() }).optional(),
  verifiability: z.string().optional(),
  inputCommitment: hex64.optional(),
  redundancy: z.object({ with: address, agreement: z.number() }).optional(),
  authenticity,
  correctness,
  merkleProof: z
    .array(z.object({ siblingHashHex: hex64, position: z.enum(["left", "right"]) }))
    .optional()
    .describe("This chunk's record under the job's HCS Merkle anchor: sibling hashes from the leaf up."),
});

const anchor = z
  .object({
    schema: z.literal("hcs.merkleRootAnchor"),
    hashAlg: z.literal("sha256"),
    leaf: z.literal("kinetic.chunk.v1"),
    merkleRoot: hex64,
    recordCount: z.number().int().positive(),
    hcsSequence: z.number().int().nonnegative(),
    tx: z.string().optional(),
  })
  .describe("The job's one hcs.merkleRootAnchor on HCS: SHA-256 Merkle root over each chunk's canonical JSON {job, idx, provider, resultHash, payTx}, in chunk order; odd levels duplicate their last node.");

const spot = z
  .object({
    tag: z.string().regex(/^0x[0-9a-f]{64}$/),
    seed: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    drawnAt: z.number().int().nonnegative(),
    seedTx: z.string().optional(),
    picks: z.array(z.number().int().nonnegative()),
    checked: z.array(z.object({ idx: z.number().int(), provider: z.string(), agreement: z.number().optional(), pass: z.boolean().optional(), zeroGRequest: z.string().optional(), model: z.string().optional() })),
    hcsSequence: z.number().int().nonnegative(),
  })
  .describe("Chunks re-run on 0G after the job, picked by a Hedera PRNG seed the verifier drew in the bond vault after the canary reveal.");

const knownCheck = z.object({ idx: z.number().int(), provider: z.string(), items: z.number().int(), correct: z.number().int(), pass: z.boolean() });

const provider = z.object({
  name: z.string(),
  address,
  payTo: z.string().optional(),
  uaid: z.string().optional(),
  gpu: z.string().optional(),
  declaredModel: z.string().optional(),
  adversarial: z.string().optional(),
  status: z.enum(["active", "offline", "slashed", "capped", "quarantined", "unqualified", "reserve"]),
  rank: z.object({ score: z.number(), price: z.number(), reliability: z.number(), speed: z.number(), checks: z.number(), latencyMs: z.number().optional(), proof: z.enum(["active", "stale", "unproven"]).optional() }).optional(),
  admission: z.object({ admitted: z.boolean(), agreement: z.number(), latencyMs: z.number() }).loose().optional(),
  price: amount,
  served: z.number().int(),
  kept: z.number().int(),
  paid: amount,
  refund: amount,
  undelivered: amount,
  vaultTx: z.string().optional(),
  slashId: z.string().optional(),
  slashStatus: z.enum(["proposed", "disputed", "executed", "overturned", "cancelled"]).optional(),
  slashSigners: z.array(z.string()).optional(),
  burned: amount.optional(),
});

const count = z.number().int().nonnegative();

const summary = z
  .object({
    verification: z.enum(["passed", "partial", "failed"]),
    assurance: z.object({ tier: z.enum(["basic", "standard", "high", "confidential"]), met: z.boolean(), shortfalls: z.array(z.string()) }),
    correctness: z.object({ groundTruth: count, redundantAgreement: count, modelAgreement: count, formatOnly: count }),
    authenticity: z.object({ byGuarantee: z.record(guarantee, count), attested: count, unavailable: count, invalid: count, unattested: count }),
    knownAnswers: z.object({ sampled: count, passed: count }),
    modelCanaries: z.object({ sampled: count, passed: count }),
    payments: z.enum(["settled", "incomplete"]),
    slashes: z.object({ executed: count, pending: count, overturned: count, cancelled: count }),
  })
  .describe("Derived from the chunks and checks: recompute it to check it.");

const signature = z.object({ address, signature: z.string(), uaid: z.string().optional() });

const canaryTee = z
  .object({
    trustMode: z.string(),
    fallback: z.string().optional(),
    provider: address,
    providerType: z.enum(["decentralized", "centralized"]).optional(),
    providerIdentity: z.string().optional(),
    guarantee: z.enum(["TeeML", "TeeTLS", "unknown"]),
    chatId: z.string(),
    scheme: z.string().optional(),
    signedText: z.string().optional(),
    signedTextHash: hex64.optional(),
    signature: z.string().optional(),
    signer: address.optional(),
    routingProof: z.object({ text: z.string(), signature: z.string() }).optional(),
    verification: z.enum(["verified", "invalid", "unavailable"]),
    reason: z.string().optional(),
    routerTeeVerified: z.boolean().nullable(),
    costUsdMicro: z.number().nonnegative(),
    chainId: z.number().int().optional(),
  })
  .describe(
    "The canary's 0G reference run, checked by the verifier itself: the trust mode (private = TeeML only), the 0G provider, the chat id, the text its TEE signed and the EIP-191 signature, the signer registered on-chain, the result, and 0G's charge. Re-check the signature offline; the signer against 0G's serving contract online.",
  );

export const passportSchema = z
  .object({
    kind: z.literal("kinetic.passport.v2"),
    jobId: z.string(),
    issuedAt: z.string(),
    network: z.string(),
    buyer: z.object({ address, uaid: z.string().optional() }),
    task: z.object({ kind: z.enum(["classify", "extract", "tag"]), labels: z.array(z.string()).optional(), fields: z.array(z.string()).optional() }),
    items: count,
    chunkSize: count,
    chunks: count,
    completed: count,
    output: z.object({ resultsHash: hex64 }),
    hcsTopic: z.string(),
    references: z.object({ x402Network: z.string(), hcsTopic: z.string(), mirrorUrl: z.string(), vault: z.string().optional(), swarmGateway: z.string(), devnetUrl: z.string().optional() }),
    strategy: z.string().optional(),
    agreement: z.object({ v: z.literal(1), task: hex64, canaryRate: z.number(), minAgreement: z.number() }).loose(),
    outcome: z.object({ met: z.boolean(), notes: z.array(z.string()) }),
    canaries: z.object({
      commitment: hex64,
      revealed: z.array(z.number().int()),
      salt: z.string(),
      checked: z.array(z.object({ idx: z.number().int(), provider: z.string(), agreement: z.number(), pass: z.boolean(), zeroGRequest: z.string(), model: z.string(), tee: canaryTee.optional() })),
      known: z.object({ commitment: hex64, placements: z.array(z.object({ idx: z.number().int(), ids: z.array(z.string()) })), salt: z.string(), checked: z.array(knownCheck) }).optional(),
    }),
    coverage: z.object({ verified: count, formatOnly: count, share: z.number(), known: count.optional() }),
    policy: z.object({ canaryRate: z.number(), minAgreement: z.number(), window: count, failLimit: count }),
    payment: z.object({ id: z.string(), symbol: z.string(), decimals: count }),
    verificationFee: z.object({ tinybar: amount, tx: z.string().optional() }),
    providers: z.array(provider),
    work: z.array(work),
    summary,
    limitations: z.array(z.string()),
    model: z
      .object({
        key: z.string().regex(/^m[0-9a-f]{15}$/),
        id: z.string(),
        version: z.string(),
        passportRef: hex64,
        passportDigest: hex64,
        royaltyBps: count,
        payTo: z.string(),
        royalty: z.object({ amount, basis: amount, tx: z.string() }).optional(),
      })
      .optional()
      .describe("A model job: the listed model, its Model Passport, and the creator's royalty."),
    anchor: anchor.optional(),
    spot: spot.optional(),
    attestations: z.object({ buyer: signature.optional(), verifier: signature.optional() }),
  })
  .describe("KINETIC Compute Passport v2: how a job's results were produced, checked and paid for. No input data, no keys.");

/** The schema as JSON Schema, for `npm run passport:schema`. */
export function passportJsonSchema(): object {
  return { $id: "urn:kinetic:compute-passport:v2", title: "KINETIC Compute Passport v2", ...z.toJSONSchema(passportSchema, { target: "draft-2020-12" }) };
}
