import type { Server } from "node:http";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { jsonReplacer } from "./crypto.js";

/** Express app with JSON (bigint-safe), raw-body capture for signature checks, and open CORS for the dashboard. */
export function createApp(): Express {
  const app = express();
  app.set("json replacer", jsonReplacer);
  app.set("trust proxy", true);
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.set("access-control-allow-origin", "*");
    res.set("access-control-allow-headers", "*");
    res.set("access-control-expose-headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-Request-ID");
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    next();
  });
  app.use(
    express.json({
      limit: "5mb",
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    }),
  );
  return app;
}

export function rawBody(req: Request): string {
  return (req as Request & { rawBody?: string }).rawBody ?? "";
}

export function listen(app: Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, (err?: Error) => (err ? reject(err) : resolve(server)));
  });
}

/** Wraps an async handler so thrown errors become JSON 500s instead of crashing the process. */
export const route =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
    fn(req, res).catch((err: Error) => {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });
  };

/** The fetch API's response (this file's `Response` is Express's). */
type FetchResponse = globalThis.Response;

/**
 * Runs an HTTP call, retrying with backoff on network errors, 429 and 5xx. Any other response
 * (including a 4xx) is returned as is: only failures to get an answer are retried.
 */
export async function withRetry(what: string, call: () => Promise<FetchResponse>, attempts = 3): Promise<FetchResponse> {
  for (let i = 1; ; i++) {
    let res: FetchResponse | undefined;
    let error: unknown;
    try {
      res = await call();
    } catch (err) {
      error = err;
    }
    const transient = !res || res.status === 429 || res.status >= 500;
    if (!transient || i >= attempts) {
      if (res) return res;
      throw new Error(`${what} failed after ${attempts} attempts: ${(error as Error)?.cause ?? (error as Error)?.message ?? error}`);
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
  }
}
