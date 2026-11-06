import { AGENT_URL, REPLAY, type ModelTask } from "./data";

// The agent API's product endpoints: sample inputs for "Try it", and publishing a model from
// the browser (testnet demo: the node's creator account signs and pays). Everything shown about
// a job or a listing afterwards is still read from Arkiv, HCS and the verifier.

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

export const getSamples = (key: string) => (REPLAY ? Promise.resolve({ texts: [] as string[] }) : json<{ texts: string[] }>(`${AGENT_URL}/models/${key}/samples`));

export interface Template {
  id: string;
  task: ModelTask;
}

export const getTemplates = () =>
  REPLAY ? Promise.resolve({ templates: [] as Template[], creator: undefined, payTo: undefined }) : json<{ templates: Template[]; creator?: string; payTo?: string }>(`${AGENT_URL}/publish/templates`);

export interface ReviewStep {
  step: "lead" | "cosigner" | "passport" | "hcs" | "arkiv";
  at: number;
  ok: boolean;
  by?: string;
  detail?: string;
  ref?: string;
}

export interface PublishState {
  key: string;
  id: string;
  version: string;
  creator: string;
  status: "publishing" | "listed" | "refused" | "failed";
  startedAt: number;
  finishedAt?: number;
  events: { at: number; message: string }[];
  feeTx?: string;
  error?: string;
  result?: { passportRef: string; accuracy: number; signers: string[] };
  review?: { status: "reviewing" | "listed" | "refused"; steps?: ReviewStep[]; reasons?: string[]; listing?: { entityKey: string } };
}

export const startPublish = (body: { template: string; id: string; version: string; name: string; description: string; license: string; royaltyBps: number }) =>
  json<PublishState>(`${AGENT_URL}/publish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const getPublish = (key: string) => json<PublishState>(`${AGENT_URL}/publish/${key}`);

/** One item's output in a finished job's report. */
export interface ItemResult {
  id: string;
  label?: string;
  tags?: string[];
  fields?: Record<string, string | null>;
}

export const outputText = (r?: ItemResult) =>
  !r ? "—" : r.label ?? (r.tags ? r.tags.join(", ") || "none" : r.fields ? Object.entries(r.fields).map(([k, v]) => `${k}: ${v ?? "—"}`).join(" · ") : "—");
