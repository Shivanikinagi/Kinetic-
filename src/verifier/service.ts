import type { Server } from "node:http";
import type { Request } from "express";
import { verifierFee } from "../core/quote.js";
import type { EntityKind } from "../integrations/arkiv.js";
import type { Services } from "../integrations/index.js";
import { PaymentGate, ReplayGuard } from "../integrations/x402.js";
import { createApp, listen, rawBody, route } from "../util/http.js";
import { logger } from "../util/log.js";
import { verifySignedRequest } from "../util/sign.js";
import { stateFile } from "../util/state.js";
import { ArkivMirror, type MirrorChange } from "./arkiv-mirror.js";
import { CosignerClient, type SlashReviewer } from "./cosigner.js";
import { Verifier, VerifierError, type JobRegistration } from "./verifier.js";
import { ModelRejected, type PublishRequest } from "../models/review.js";
import type { ModelRunner } from "../models/runner.js";

/**
 * HTTP front for the verifier. Every job and result call must be signed by the job's buyer.
 * Registering a job is itself an x402 payment: the buyer pays the verifier a fee per chunk,
 * which is what funds the 0G reference runs and is the verifier agent's income.
 */
export async function startVerifier(svc: Services, port: number, opts: { cosigners?: SlashReviewer[]; modelRunner?: ModelRunner } = {}): Promise<{ verifier: Verifier; url: string; close: () => Promise<void> }> {
  // The vault's other verifiers, each re-checking a slash before it co-signs (VERIFIER_COSIGNERS).
  const cosigners = opts.cosigners ?? svc.cfg.quorum.cosigners.map((url) => new CosignerClient(url, svc.account));
  const verifier = new Verifier(svc, svc.zerog(), svc.receipts(), undefined, cosigners, { modelRunner: opts.modelRunner });
  verifier.startSettling();
  // ERC-8004 on 0G Chain: register this verifier, then give GPUs feedback after every job.
  verifier.startErc8004();
  // Each job gets its own fee gate (the fee depends on its size), so they share one replay
  // guard: a fee header that paid for one job can't register another.
  const feeReplay = new ReplayGuard(stateFile(svc.cfg, `replay-${svc.address}.json`));
  const feeGate = new PaymentGate({
    network: svc.cfg.x402.network,
    facilitatorUrl: svc.cfg.x402.facilitatorUrl,
    facilitatorUrls: svc.cfg.x402.facilitatorUrls,
    asset: svc.cfg.x402.asset,
    payTo: svc.payTo,
    amount: svc.cfg.verifierFeePerChunkTinybar,
    description: "KINETIC verification fee (hidden canaries checked against 0G verified runs)",
    replay: feeReplay,
  });
  const app = createApp();

  const authenticate = async (req: Request) => {
    try {
      return await verifySignedRequest(req.headers, rawBody(req));
    } catch (err) {
      throw new VerifierError(401, (err as Error).message);
    }
  };
  const fail = (res: Parameters<Parameters<typeof route>[0]>[1], err: unknown) => {
    if (err instanceof ModelRejected) return void (res.headersSent || res.status(400).json({ error: err.message, reasons: err.reasons }));
    const status = err instanceof VerifierError ? err.status : 500;
    if (!res.headersSent) res.status(status).json({ error: (err as Error).message });
  };
  const signed = (fn: (signer: string, req: Request) => Promise<unknown>) =>
    route(async (req, res) => {
      try {
        res.json(await fn(await authenticate(req), req));
      } catch (err) {
        fail(res, err);
      }
    });

  app.get("/status", route(async (_req, res) => void res.json(await verifier.status())));

  // The ERC-8004 reputation this verifier gave, read from 0G Chain (cached: each is a contract call).
  const repCache = new Map<number, { at: number; body: unknown }>();
  app.get(
    "/erc8004/reputation",
    route(async (req, res) => {
      const ids = String(req.query.ids ?? "")
        .split(",")
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 0)
        .slice(0, 50);
      const stale = ids.filter((id) => Date.now() - (repCache.get(id)?.at ?? 0) > 60_000);
      if (stale.length) for (const r of await verifier.erc8004Reputation(stale)) repCache.set(r.agentId, { at: Date.now(), body: r });
      res.json({ agents: ids.map((id) => repCache.get(id)?.body).filter(Boolean) });
    }),
  );

  // Arkiv reads for the dashboard, from a live mirror: Arkiv's entity events keep it current (each
  // changed entity re-read with getEntity, which isn't metered), a full read every few minutes
  // corrects anything missed, and the Arkiv access key stays server-side. GET /arkiv/events pushes
  // the changes as Server-Sent Events; GET /arkiv/:kind serves the current entities.
  const KINDS: EntityKind[] = ["offer", "claim", "job", "chunk", "reputation", "check", "model"];
  const mirror = new ArkivMirror(svc.arkiv, {
    kinds: KINDS,
    // The old polling cadence: used while the watcher is failing, and to estimate the reads saved.
    pollMs: { offer: 8000, claim: 6000, job: 8000, chunk: 15_000, reputation: 30_000, check: 60_000, model: 60_000 },
    // Sorted by Arkiv: the newest offer and listing first (a restarted provider has two offers for
    // a while), the best reputation first.
    order: { offer: { attr: "$expiresAt", desc: true }, model: { attr: "$expiresAt", desc: true }, reputation: { attr: "score", desc: true } },
    log: logger("arkiv-mirror"),
  });
  const arkivError = (err: unknown) => {
    const msg = (err as Error).message;
    return /RATE_LIMITED|429/.test(msg) ? "Arkiv is rate-limiting this node; set ARKIV_API_KEY" : msg.slice(0, 300);
  };
  app.get("/arkiv/stats", route(async (_req, res) => void res.json(mirror.stats())));
  app.get(
    "/arkiv/events",
    route(async (req, res) => {
      const asked = String(req.query.kinds ?? "").split(",").filter(Boolean) as EntityKind[];
      const kinds = asked.length ? asked.filter((k) => KINDS.includes(k)) : KINDS.filter((k) => k !== "check");
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write("retry: 3000\n\n");
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      // Subscribed before the snapshots, so nothing between them is lost (an upsert is idempotent).
      const buffered: MirrorChange[] = [];
      let ready = false;
      const unsubscribe = mirror.subscribe((c) => {
        if (!kinds.includes(c.kind)) return;
        if (ready) send("change", c);
        else buffered.push(c);
      });
      const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(ping);
        unsubscribe();
      });
      await Promise.all(
        kinds.map((kind) =>
          mirror
            .snapshot(kind)
            .then((snap) => send("snapshot", snap))
            .catch((err) => send("failed", { kind, error: arkivError(err) })),
        ),
      );
      ready = true;
      for (const c of buffered.splice(0)) send("change", c);
    }),
  );
  app.get(
    "/arkiv/:kind",
    route(async (req, res) => {
      const kind = String(req.params.kind) as EntityKind;
      if (!KINDS.includes(kind)) return void res.status(404).json({ error: "unknown kind" });
      try {
        res.json(await mirror.snapshot(kind));
      } catch (err) {
        res.status(503).json({ error: arkivError(err) });
      }
    }),
  );
  app.get(
    "/jobs/:id/canaries",
    route(async (req, res) => {
      try {
        res.json({ canaries: verifier.canaries(String(req.params.id)) });
      } catch (err) {
        fail(res, err);
      }
    }),
  );

  app.post(
    "/jobs",
    route(async (req, res) => {
      try {
        const signer = await authenticate(req);
        const reg = req.body as JobRegistration;
        if (String(reg.buyer ?? "").toLowerCase() !== signer) throw new VerifierError(403, "buyer must sign its own job");
        if (!Array.isArray(reg.chunks) || reg.chunks.length === 0) throw new VerifierError(400, "job has no chunks");
        // Checking more chunks than the protocol's rate costs proportionally more: each check is a paid 0G run.
        const rate = Number(reg.agreement?.canaryRate ?? svc.cfg.policy.canaryRate);
        const fee = verifierFee(reg.chunks.length, svc.cfg.verifierFeePerChunkTinybar, rate, svc.cfg.policy.canaryRate, reg.agreement?.tier ?? "standard");
        // A buyer's firm quote must state the fee this verifier really charges.
        if (reg.agreement?.quote && reg.agreement.quote.fee !== fee.toString()) {
          throw new VerifierError(400, `the quote's verifier fee (${reg.agreement.quote.fee}) differs from the fee charged (${fee})`);
        }
        if (fee === 0n) return void res.json(await verifier.registerJob(reg));
        let settled: { tx: string; amount: bigint } | undefined;
        const gate = new PaymentGate({
          network: svc.cfg.x402.network,
          facilitatorUrl: svc.cfg.x402.facilitatorUrl,
          facilitatorUrls: svc.cfg.x402.facilitatorUrls,
          asset: svc.cfg.x402.asset,
          payTo: svc.payTo,
          amount: fee,
          description: `KINETIC verification fee for ${reg.chunks.length} chunks`,
          onSettled: (s, amount) => (settled = { tx: s.transaction, amount }),
          replay: feeReplay,
        });
        // Registration runs only after the facilitator verifies the payment; it settles only if registration succeeds.
        let registered = false;
        await gate.handle(req, res, async () => {
          const out = await verifier.registerJob(reg);
          registered = true;
          return { ...out, feeTinybar: fee.toString() };
        }, fee);
        if (settled) verifier.recordFee(reg.jobId, settled.amount, settled.tx);
        // The fee didn't settle after the job was registered: don't keep a job nobody paid for.
        else if (registered) verifier.dropJob(reg.jobId);
      } catch (err) {
        fail(res, err);
      }
    }),
  );
  // ── Model hub ──
  // Publishing a model: the creator signs the request and pays the listing fee over x402. The fee
  // pays for the review (malware checks, benchmark and fingerprint by every verifier in the
  // quorum), which takes minutes on real networks, far longer than a payment stays valid. So the
  // quick checks run first (a bad card is refused before any payment), the fee settles, and the
  // review runs in the background: the creator polls GET /models/reviews/:key.
  app.post(
    "/models",
    route(async (req, res) => {
      try {
        const signer = await authenticate(req);
        const body = req.body as PublishRequest;
        const key = await verifier.models.admit(body, signer);
        const fee = svc.cfg.models.listingFeeTinybar;
        const ack = () => ({ key, id: body.card.id, version: body.card.version, status: "reviewing" as const });
        if (fee === 0n) {
          verifier.models.start(body, signer);
          return void res.status(202).json(ack());
        }
        const gate = new PaymentGate({
          network: svc.cfg.x402.network,
          facilitatorUrl: svc.cfg.x402.facilitatorUrl,
          facilitatorUrls: svc.cfg.x402.facilitatorUrls,
          asset: svc.cfg.x402.asset,
          payTo: svc.payTo,
          amount: fee,
          description: "KINETIC model listing fee (malware checks, benchmark and fingerprint by a verifier quorum)",
          // The review starts only once the fee has settled.
          onSettled: () => void verifier.models.start(body, signer),
          replay: feeReplay,
        });
        await gate.handle(req, res, async () => ack(), fee);
      } catch (err) {
        fail(res, err);
      }
    }),
  );
  app.get(
    "/models/reviews/:key",
    route(async (req, res) => {
      const review = verifier.models.review(String(req.params.key));
      if (!review) return void res.status(404).json({ error: "no review for that model" });
      res.json(review);
    }),
  );
  app.get("/models", route(async (_req, res) => void res.json({ models: verifier.models.list().map(({ fingerprint: _f, ...m }) => m) })));
  // The Model Passport, served from Swarm through the verifier (the dashboard can't always reach the gateway directly).
  app.get(
    "/models/:key/passport",
    route(async (req, res) => {
      const listing = verifier.models.get(String(req.params.key));
      if (!listing) return void res.status(404).json({ error: "unknown model" });
      try {
        res.type("application/json").send(Buffer.from(await svc.swarm.download(listing.passportRef)));
      } catch (err) {
        res.status(502).json({ error: (err as Error).message });
      }
    }),
  );
  // The creator's royalty: the buyer pays it over x402 straight to the creator's account, for
  // the amount this verifier computes from the chunks it accepted.
  app.post(
    "/jobs/:id/royalty",
    route(async (req, res) => {
      try {
        const signer = await authenticate(req);
        const jobId = String(req.params.id);
        const due = verifier.royaltyDue(jobId, signer);
        if (due.amount === 0n) return void res.json({ ...due, basis: due.basis.toString(), amount: "0" });
        const gate = new PaymentGate({
          network: svc.cfg.x402.network,
          facilitatorUrl: svc.cfg.x402.facilitatorUrl,
          facilitatorUrls: svc.cfg.x402.facilitatorUrls,
          asset: svc.cfg.x402.asset,
          payTo: due.payTo,
          amount: due.amount,
          description: `KINETIC creator royalty (${due.royaltyBps / 100}% of accepted chunk payments)`,
          // Recorded the moment it settles, before the buyer hears back and asks for a co-signature.
          onSettled: (s) => void verifier.recordRoyalty(jobId, due, s.transaction).catch((err: Error) => console.error(`royalty receipt for ${jobId} failed: ${err.message}`)),
          replay: feeReplay,
        });
        await gate.handle(req, res, async () => ({ ...due, basis: due.basis.toString(), amount: due.amount.toString() }), due.amount);
      } catch (err) {
        fail(res, err);
      }
    }),
  );

  // Admission check before the buyer routes paid work to a provider. Signed, so only known
  // buyers can make the verifier spend on probes; results are cached per provider.
  app.post("/qualify", signed((signer, req) => verifier.qualify(req.body, signer)));
  app.post("/jobs/:id/results", signed((signer, req) => verifier.submit(String(req.params.id), signer, req.body)));
  app.post("/jobs/:id/finalize", signed((signer, req) => verifier.finalize(String(req.params.id), signer)));
  // Co-signs the job's Compute Passport once it matches the verifier's own records.
  app.post("/jobs/:id/attest", signed((signer, req) => verifier.attest(String(req.params.id), signer, req.body)));

  // Fail fast if the facilitator cannot settle on this network.
  await feeGate.getRequirements();
  const server: Server = await listen(app, port);
  return {
    verifier,
    url: `http://localhost:${port}`,
    close: () => new Promise<void>((r) => (verifier.stopSettling(), mirror.stop(), server.closeAllConnections(), server.close(() => r()))),
  };
}
