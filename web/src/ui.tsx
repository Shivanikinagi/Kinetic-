import { useState, type ReactNode } from "react";
import { amountOf, hashscan, hbar, providerColor, short, type Entity, type ItemOutput, type Receipt, type Status } from "./data";

export type Tone = "ok" | "warn" | "bad" | "idle";

export function Eyebrow({ n, label, right }: { n?: string; label: string; right?: ReactNode }) {
  return (
    <div className="eyebrow">
      <span>
        {n ? `// ${n} · ` : "// "}
        {label}
      </span>
      {right !== undefined && (
        <>
          <span className="line" />
          {right}
        </>
      )}
    </div>
  );
}

export function Tag({ tone = "idle", live, children }: { tone?: Tone; live?: boolean; children: ReactNode }) {
  return <span className={`tag ${tone === "idle" ? "" : tone} ${live ? "live" : ""}`}>{children}</span>;
}

const STATUS_TONE: Record<string, Tone> = {
  complete: "ok",
  live: "ok",
  admitted: "ok",
  running: "warn",
  starting: "warn",
  open: "warn",
  incomplete: "bad",
  failed: "bad",
  slashed: "bad",
  rejected: "bad",
  halted: "bad",
};

export const StatusTag = ({ status }: { status: string }) => (
  <Tag tone={STATUS_TONE[status] ?? "idle"} live={status === "running" || status === "live"}>
    {status}
  </Tag>
);

/** A numbered pipeline row; expandable when it has a body. */
export function Stage({ n, title, sub, note, tag, defaultOpen, children }: { n: number; title: string; sub?: string; note?: ReactNode; tag: ReactNode; defaultOpen?: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const head = (
    <>
      <span className="stage-n">{String(n).padStart(2, "0")}</span>
      <span className="stage-title">
        {title}
        {sub && <span className="sub"> · {sub}</span>}
      </span>
      {note && <span className="stage-note">{note}</span>}
      {tag}
    </>
  );
  return (
    <div className="stage">
      {children ? (
        <button className="stage-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          {head}
        </button>
      ) : (
        <div className="stage-head">{head}</div>
      )}
      {children && open && <div className="stage-body">{children}</div>}
    </div>
  );
}

export function KV({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TxLink({ status, kind = "transaction", id, text }: { status: Status; kind?: "transaction" | "topic" | "contract" | "account" | "token"; id: string; text?: string }) {
  const link = hashscan(status, kind, id);
  const shown = text ?? short(id, 10);
  return link ? (
    <a className="ext mono" href={link} target="_blank" rel="noreferrer">
      {shown}
    </a>
  ) : (
    <span className="mono">{shown}</span>
  );
}

export function ProviderName({ addr, label }: { addr: string; label: (a: string) => string }) {
  return (
    <span className="provider-name">
      <span className="dot" style={{ background: providerColor(addr) }} />
      {label(addr)}
    </span>
  );
}

export function Meter({ value, threshold }: { value: number; threshold: number }) {
  return (
    <span className="meter" title={`${Math.round(value * 100)}% (pass at ${Math.round(threshold * 100)}%)`}>
      <span className={`meter-fill ${value >= threshold ? "" : "bad"}`} style={{ width: `${Math.round(value * 100)}%` }} />
      <span className="meter-mark" style={{ left: `${threshold * 100}%` }} />
      <span className="meter-text">{Math.round(value * 100)}%</span>
    </span>
  );
}

const render = (o?: ItemOutput) => (!o ? "—" : o.label ?? (o.tags ? o.tags.join(", ") || "∅" : o.fields ? Object.values(o.fields).filter(Boolean).join(", ") || "∅" : "—"));

export function Diff({ expected, actual }: { expected: ItemOutput[]; actual: ItemOutput[] }) {
  const byId = new Map(actual.map((a) => [a.id, a]));
  const diffs = expected.filter((e) => render(e) !== render(byId.get(e.id)));
  if (diffs.length === 0) return <span className="ok">all items match</span>;
  return (
    <ul className="diff">
      {diffs.slice(0, 3).map((e) => (
        <li key={e.id}>
          <span className="mono muted">{e.id}</span> {render(e)} → <span className="bad">{render(byId.get(e.id))}</span>
        </li>
      ))}
      {diffs.length > 3 && <li className="muted">+{diffs.length - 3} more</li>}
    </ul>
  );
}

const CHUNK_STATES = ["verified", "done", "claimed", "pending"] as const;

export function Progress({ chunks, total }: { chunks: Entity[]; total: number }) {
  const count = (s: string) => chunks.filter((c) => c.attrs.status === s).length;
  const denom = Math.max(total, chunks.length, 1);
  return (
    <div className="progress" role="img" aria-label={CHUNK_STATES.map((s) => `${count(s)} ${s}`).join(", ")}>
      {CHUNK_STATES.map((s) => (
        <span key={s} className={`seg ${s}`} style={{ width: `${(count(s) / denom) * 100}%` }} />
      ))}
    </div>
  );
}

export function ChunkGrid({ chunks, label, failed }: { chunks: Entity[]; label: (a: string) => string; failed?: Map<number, boolean> }) {
  return (
    <>
      <div className="chunks" role="list" aria-label="chunk states">
        {chunks.map((c) => {
          const idx = Number(c.attrs.idx);
          const provider = String(c.attrs.provider || "");
          const canary = failed?.get(idx);
          const state = canary === false ? "failed" : String(c.attrs.status);
          return (
            <span key={c.key} role="listitem" className={`chunk ${state}`} title={`#${idx} ${c.attrs.status}${provider ? ` · ${label(provider)}` : ""}${canary === undefined ? "" : canary ? " · canary passed" : " · canary failed"}`}>
              {canary === undefined ? "" : canary ? "✓" : "✗"}
              {provider && <span className="owner" style={{ background: providerColor(provider) }} />}
            </span>
          );
        })}
      </div>
      <div className="legend">
        <span>
          <span className="chunk mini verified" /> canary passed
        </span>
        <span>
          <span className="chunk mini done" /> accepted
        </span>
        <span>
          <span className="chunk mini failed" /> canary failed
        </span>
        <span>
          <span className="chunk mini claimed" /> in flight
        </span>
        <span>
          <span className="chunk mini pending" /> waiting
        </span>
        <span>underline = provider</span>
      </div>
    </>
  );
}

// ── HCS receipts: one description for the screen ──

/** Receipt types, grouped by what they're about: [group id, group name, [type, type name][]]. */
export const RECEIPT_GROUPS: [string, string, [string, string][]][] = [
  ["jobs", "Jobs", [
    ["job", "Registered"],
    ["reveal", "Canary reveals"],
    ["anchor", "Merkle anchors"],
    ["done", "Closed"],
  ]],
  ["payments", "Payments", [
    ["chunk", "Chunk payments"],
    ["royalty", "Royalties"],
    ["settle", "Settlements"],
  ]],
  ["checks", "Quality checks", [
    ["canary", "Canaries"],
    ["known", "Known answers"],
    ["redundant", "Agreements"],
    ["spot", "Spot checks"],
    ["format", "Malformed"],
  ]],
  ["providers", "Providers", [
    ["qualify", "Admission"],
    ["fingerprint", "Model checks"],
    ["dispute", "Disputes"],
    ["slash", "Slashes"],
    ["slash-refused", "Slashes refused"],
  ]],
  ["models", "Models", [["model", "Model Passports"]]],
];

/** Every type, flat, with "all" first. */
export const RECEIPT_TYPES: [string, string][] = [["all", "All"], ...RECEIPT_GROUPS.flatMap(([, , types]) => types)];

export function receiptTone(r: Receipt): Tone {
  if (r.t === "dispute" || r.t === "slash-refused") return "warn";
  if (r.t === "known") return r.pass ? "ok" : "bad";
  if (r.t === "redundant" || r.t === "model" || r.t === "royalty") return "ok";
  if (r.t === "slash" || (r.t === "settle" && r.outcome === "executed") || r.t === "format" || (r.t === "canary" && !r.pass) || (r.t === "qualify" && !r.admitted) || (r.t === "fingerprint" && r.verdict === "mismatch")) return "bad";
  if (r.t === "done" || r.t === "settle" || (r.t === "canary" && r.pass) || (r.t === "qualify" && r.admitted) || (r.t === "fingerprint" && r.verdict === "consistent")) return "ok";
  return "idle";
}

const TAG_TEXT: Record<string, string> = { model: "model passport", royalty: "royalty", qualify: "admission", fingerprint: "model check", job: "job", chunk: "x402 pay", canary: "canary", format: "malformed", slash: "slash", known: "known answer", redundant: "2 agree", "slash-refused": "no quorum", dispute: "dispute", settle: "settled", reveal: "reveal", spot: "spot check", anchor: "merkle anchor", done: "closed" };
export const receiptTag = (r: Receipt) => TAG_TEXT[r.t] ?? r.t;

export function ReceiptText({ r, status, label, openJob }: { r: Receipt; status: Status; label: (a: string) => string; openJob?: (id: string) => void }) {
  const job = r.job ? (
    openJob ? (
      <button className="link mono" onClick={() => openJob(String(r.job))}>
        {short(String(r.job), 8)}
      </button>
    ) : (
      <span className="mono">{short(String(r.job), 8)}</span>
    )
  ) : null;
  const who = <ProviderName addr={String(r.provider)} label={label} />;
  switch (r.t) {
    case "job":
      return (
        <>
          {job} registered, {Number(r.chunks)} chunks · canary set committed <span className="mono muted">{short(String(r.commitment))}</span>
        </>
      );
    case "chunk":
      return (
        <>
          {job} #{Number(r.idx)} by {who} · paid {amountOf(status, r.amount as string, r.asset)} · <TxLink status={status} id={String(r.payTx)} />
        </>
      );
    case "canary":
      return (
        <>
          {job} #{Number(r.idx)} {who} <b className={r.pass ? "ok" : "bad"}>{r.pass ? "pass" : "fail"}</b> · {Math.round(Number(r.agreement) * 100)}% agreement with 0G
        </>
      );
    case "qualify":
      return (
        <>
          {who} <b className={r.admitted ? "ok" : "bad"}>{r.admitted ? "admitted" : "rejected"}</b> · {Math.round(Number(r.agreement) * 100)}% of known answers in {(Number(r.latencyMs) / 1000).toFixed(1)} s
          {r.reason ? <span className="muted"> · {String(r.reason)}</span> : null}
        </>
      );
    case "fingerprint":
      return (
        <>
          {who} declares <span className="mono">{String(r.declared)}</span>:{" "}
          <b className={r.verdict === "consistent" ? "ok" : r.verdict === "mismatch" ? "bad" : ""}>
            {r.verdict === "consistent" ? "answers like it" : r.verdict === "mismatch" ? "doesn't answer like it" : "inconclusive"}
          </b>{" "}
          · {Math.round(Number(r.match) * 100)}% match{r.closest ? <span className="muted"> · closest: {String(r.closest)}</span> : null}
        </>
      );
    case "format":
      return (
        <>
          {job} #{Number(r.idx)} from {who} rejected: <span className="muted">{(r.problems as string[]).join("; ")}</span>
        </>
      );
    case "slash":
      return r.slashId ? (
        <>
          {who} <b className="bad">slash proposed</b> in {job} after {Number(r.failures)}/{Number(r.window)} failed checks · signed by {(r.signers as string[] | undefined)?.length ?? 1} verifiers · asks {hbar(r.refund as string)} · <TxLink status={status} id={String(r.vaultTx)} />
        </>
      ) : (
        <>
          {who} <b className="bad">slashed</b> in {job} after {Number(r.failures)}/{Number(r.window)} failed checks · refunded {hbar(r.refund as string)} · <TxLink status={status} id={String(r.vaultTx)} />
        </>
      );
    case "known":
      return (
        <>
          {job} #{Number(r.idx)} from {who}: <b className={r.pass ? "ok" : "bad"}>{r.pass ? "known answer right" : "missed a known answer"}</b>{" "}
          <span className="muted">({Number(r.correct)}/{Number(r.items)}, ground truth)</span>
        </>
      );
    case "redundant":
      return (
        <>
          {job} #{Number(r.idx)}: two independent providers <b className="ok">agree</b> ({Math.round(Number(r.agreement) * 100)}%)
          {(r.outvoted as string[]).length ? <span className="warn"> · {(r.outvoted as string[]).length} outvoted</span> : null}
        </>
      );
    case "slash-refused":
      return (
        <>
          {who} not slashed in {job}: only {(r.signers as string[]).length} of {Number(r.need)} verifiers confirmed the failures
          {(r.reasons as string[]).length ? <span className="muted"> · {(r.reasons as string[])[0]}</span> : null}
        </>
      );
    case "dispute":
      return (
        <>
          {who} <b className="warn">disputed</b> its slash in {job} · verifiers re-checked: {Number(r.upheld)} uphold, {Number(r.overturned)} overturn
        </>
      );
    case "settle":
      return r.outcome === "executed" ? (
        <>
          {who} <b className="bad">slashed</b> in {job} · refunded {hbar(r.refund as string)} · burned {hbar(r.burned as string)}
          {r.scheduled ? <span className="muted"> · executed by the vault's own schedule (HIP-1215)</span> : null} · <TxLink status={status} id={String(r.vaultTx)} />
        </>
      ) : (
        <>
          {who}'s slash in {job} <b className="ok">{String(r.outcome)}</b>: bond kept · <TxLink status={status} id={String(r.vaultTx)} />
        </>
      );
    case "reveal":
      return (
        <>
          {job} canaries revealed: <span className="mono muted">{(r.canaries as number[]).join(", ")}</span>
        </>
      );
    case "spot": {
      const checked = r.checked as { idx: number; pass?: boolean }[];
      return (
        <>
          {job} spot checks picked by Hedera PRNG seed <span className="mono muted">{short(String(r.seed))}</span>: chunks <span className="mono muted">{(r.picks as number[]).join(", ") || "none"}</span> ·{" "}
          {checked.filter((c) => c.pass).length} of {checked.filter((c) => c.pass !== undefined).length} agreed with 0G
        </>
      );
    }
    case "anchor":
      return (
        <>
          {job} {Number(r.recordCount)} chunks anchored · Merkle root <span className="mono muted">{short(String(r.merkleRoot))}</span>
        </>
      );
    case "model":
      return (
        <>
          <a className="link" href={`#/models/${String(r.model)}`}>
            {String(r.id)}@{String(r.version)}
          </a>{" "}
          <b className="ok">listed</b> · benchmark {Math.round(Number(r.accuracy) * 100)}% · Model Passport signed by {(r.signers as string[]).length} verifiers · {Number(r.royaltyBps) / 100}% royalty
        </>
      );
    case "royalty":
      return (
        <>
          {job} paid its model's creator <b className="ok">{hbar(r.amount as string)}</b> royalty on {Number(r.chunks)} accepted chunks · <TxLink status={status} id={String(r.tx)} />
        </>
      );
    case "done":
      return (
        <>
          {job} closed · {Number(r.verified)} chunks kept · paid {amountOf(status, r.paid as string, r.asset)} · refunded {hbar(r.refunded as string)} · fee {amountOf(status, (r.fee as string) ?? 0, r.asset)}
        </>
      );
    default:
      return <span className="mono muted">{JSON.stringify(r)}</span>;
  }
}

export const timeOf = (r: Receipt) => new Date(Number(r.ts.split(".")[0]) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
