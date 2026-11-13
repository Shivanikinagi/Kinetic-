import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { getSamples, outputText } from "../api";
import { getRuns, hashscan, hbar, REPLAY, startRun, type ChunkLogEntry, type ModelListing, type Run } from "../data";
import type { Snapshot } from "../live";

// "Chat" on a model page: every message is a real KINETIC job of one item on this model. It is
// paid over x402, checked against hidden answers, and refunded if the GPU cheats. The reply shows
// what the job's own report says: which GPU answered, the payment, the check and the speed.
// Speed (tokens/s) is what the provider's model server reported: unsigned, shown, never paid on.

const ENDED = ["complete", "incomplete", "failed", "halted"];

interface Turn {
  id: number;
  text: string;
  runId?: string;
  run?: Run;
  error?: string;
}

/** Output tokens per second over the whole model call, when the model server reported tokens. */
const tokensPerSecond = (c?: ChunkLogEntry) =>
  c?.usage?.completionTokens !== undefined && c.usage.latencyMs > 0 ? c.usage.completionTokens / (c.usage.latencyMs / 1000) : undefined;

const secs = (ms?: number) => (ms === undefined ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export default function Chat({ snap, m, serving }: { snap: Snapshot; m: ModelListing; serving: number }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [samples, setSamples] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const nextId = useRef(1);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    getSamples(m.key)
      .then((s) => alive && setSamples(s.texts.slice(0, 3)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [m.key]);

  // Poll the agent while any message's job is still running.
  const pending = turns.filter((t) => t.runId && !(t.run && ENDED.includes(t.run.status))).map((t) => t.runId!);
  const pendingKey = pending.join(",");
  useEffect(() => {
    if (!pendingKey) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const { runs } = await getRuns();
        if (!alive) return;
        const byId = new Map(runs.map((r) => [r.runId, r]));
        setTurns((ts) => ts.map((t) => (t.runId && byId.has(t.runId) ? { ...t, run: byId.get(t.runId) } : t)));
      } catch {
        // Keep the last state; try again.
      }
      if (alive) timer = setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [pendingKey]);

  useEffect(() => bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), [turns]);

  const busy = sending || pending.length > 0;
  const canSend = !busy && !REPLAY && serving > 0 && draft.trim().length > 0;

  const send = async (text = draft) => {
    const msg = text.trim();
    if (!msg || busy) return;
    const id = nextId.current++;
    setTurns((ts) => [...ts, { id, text: msg }]);
    setDraft("");
    setSending(true);
    try {
      const run = await startRun({ model: m.key, texts: [msg], items: 1, chunkSize: 1, maxSpendTinybar: "20000000", maxPriceTinybar: "500000" });
      setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, runId: run.runId, run } : t)));
    } catch (err) {
      setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, error: (err as Error).message } : t)));
    } finally {
      setSending(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) void send();
    }
  };

  // Speed across this session's answered messages.
  const logs = turns.flatMap((t) => t.run?.report?.chunkLog?.slice(0, 1) ?? []);
  const last = logs[logs.length - 1];
  const rates = logs.map(tokensPerSecond).filter((r): r is number => r !== undefined);
  const avg = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : undefined;
  const task = m.card.task;
  const answers = task.labels?.map((l) => l.name) ?? task.fields?.map((f) => f.name) ?? [];

  return (
    <div className="chat">
      <div className="chat-main">
        <div className="try-head">
          <div>
            <h3>Chat</h3>
            <p className="muted small">
              Each message runs as a real job: one GPU answers, it's paid over x402 and checked against hidden answers, and you're refunded if it cheats.
            </p>
          </div>
          <span className="tag">{serving ? `${serving} GPU${serving === 1 ? "" : "s"} serving` : "no GPU serving"}</span>
        </div>

        <p className="chat-task small">
          This model {task.kind === "classify" ? "labels" : task.kind === "tag" ? "tags" : "extracts fields from"} your message
          {answers.length > 0 && (
            <>
              {task.kind === "extract" ? ": " : " as "}
              {answers.map((a, i) => (
                <span key={a}>
                  <code>{a}</code>
                  {i < answers.length - 1 ? (i === answers.length - 2 ? " or " : ", ") : ""}
                </span>
              ))}
            </>
          )}
          .
        </p>

        <div className="chat-log" aria-live="polite">
          {turns.length === 0 && (
            <div className="chat-empty">
              <p className="muted small">Try one of these, or write your own:</p>
              <div className="chat-samples">
                {samples.map((s) => (
                  <button key={s} className="chat-sample" onClick={() => void send(s)} disabled={busy || REPLAY || serving === 0}>
                    {s}
                  </button>
                ))}
                {samples.length === 0 && <span className="muted small">No sample inputs for this model's task.</span>}
              </div>
            </div>
          )}
          {turns.map((t) => (
            <div key={t.id} className="chat-turn">
              <div className="bubble me">{t.text}</div>
              <Reply turn={t} snap={snap} />
            </div>
          ))}
          <div ref={bottom} />
        </div>

        <div className="chat-compose">
          <textarea
            className="try-input"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={REPLAY ? "The replay can't run jobs. Switch to live to chat." : serving === 0 ? "No GPU is serving this model right now." : "Message (Enter to send, Shift+Enter for a new line)"}
            disabled={busy || REPLAY || serving === 0}
          />
          <button className="btn primary" onClick={() => void send()} disabled={!canSend}>
            {busy ? "Running…" : "Send"}
          </button>
        </div>
        <p className="muted small chat-note">Budget per message: 0.2 ℏ, at most 0.005 ℏ per chunk.</p>
      </div>

      <aside className="chat-side">
        <Gauge value={tokensPerSecond(last)} />
        <dl className="chat-stats">
          <div>
            <dt>Session average</dt>
            <dd>{avg !== undefined ? `${avg.toFixed(1)} tok/s` : "—"}</dd>
          </div>
          <div>
            <dt>Output tokens</dt>
            <dd>{last?.usage?.completionTokens ?? "—"}</dd>
          </div>
          <div>
            <dt>Model call</dt>
            <dd>{secs(last?.usage?.latencyMs)}</dd>
          </div>
          <div>
            <dt>Paid → checked</dt>
            <dd>{secs(last?.roundTripMs)}</dd>
          </div>
          <div>
            <dt>Answered by</dt>
            <dd>{last?.name ?? "—"}</dd>
          </div>
        </dl>
        <p className="muted small">
          Speed is what the GPU's model server reported for the whole call, including reading the prompt. It isn't signed, so it never affects pay or slashing.
        </p>
        {last && last.usage && last.usage.completionTokens === undefined && <p className="muted small">This GPU's model server sent no token counts.</p>}
      </aside>
    </div>
  );
}

function Reply({ turn, snap }: { turn: Turn; snap: Snapshot }) {
  const run = turn.run;
  const jobId = run?.jobId;
  const receipts = useMemo(() => (jobId ? snap.receipts.filter((x) => x.job === jobId) : []), [snap.receipts, jobId]);

  if (turn.error) return <div className="bubble them bad">Couldn't start the job: {turn.error}</div>;
  if (!run) return <div className="bubble them pending">Starting a job…</div>;

  const ended = ENDED.includes(run.status);
  if (!ended) {
    const paid = receipts.some((x) => x.t === "chunk");
    const checked = receipts.some((x) => x.t === "known" || x.t === "canary");
    const stage = !jobId ? "Admitting a GPU with a known-answer probe…" : checked ? "Checking the answer…" : paid ? "Paid over x402, waiting for the answer…" : "Committing the rules on Hedera…";
    return (
      <div className="bubble them pending">
        <span className="chat-dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        {stage}
      </div>
    );
  }

  const report = run.report;
  const result = report?.results?.[0];
  const log = report?.chunkLog?.[0];
  const ok = run.status === "complete";
  const tx = log?.payTx ? hashscan(snap.status, "transaction", log.payTx) : null;
  const tps = tokensPerSecond(log);
  const slashed = receipts.some((x) => x.t === "slash");

  return (
    <div className={`bubble them${ok ? "" : " bad"}`}>
      {result ? <div className="chat-answer">{outputText(result)}</div> : <div>{run.error ?? `Job ${run.status}: ${(report?.outcome?.notes ?? []).join(" · ") || "no answer was accepted"}`}</div>}
      {log && (
        <div className="chat-receipt">
          <span className={log.check === "verified" ? "verified" : ""}>{log.check === "verified" ? "✓ matched 0G reference" : "✓ format checked"}</span>
          {log.known && (
            <span>
              known answers {log.known.correct}/{log.known.items}
            </span>
          )}
          <span>{log.name}</span>
          {tx ? (
            <a href={tx} target="_blank" rel="noreferrer">
              paid {hbar(log.amount)} ↗
            </a>
          ) : (
            <span>paid {hbar(log.amount)}</span>
          )}
          {tps !== undefined && <span>{tps.toFixed(1)} tok/s</span>}
        </div>
      )}
      {slashed && <div className="chat-receipt warn">A GPU was slashed on this job: you were refunded and its chunk was rerouted.</div>}
      {jobId && (
        <a className="chat-link small" href={`#/jobs/${encodeURIComponent(jobId)}`}>
          Job & Compute Passport →
        </a>
      )}
    </div>
  );
}

/** A half-circle speed gauge. The scale grows with the reading so it never pins at the end. */
function Gauge({ value }: { value?: number }) {
  const max = Math.max(50, Math.ceil(((value ?? 0) * 1.25) / 25) * 25);
  const share = value === undefined ? 0 : Math.min(1, value / max);
  const r = 70;
  const len = Math.PI * r;
  return (
    <div className="gauge">
      <svg viewBox="0 0 180 100" role="img" aria-label={value === undefined ? "No speed yet" : `${value.toFixed(1)} tokens per second`}>
        <path d="M 20 90 A 70 70 0 0 1 160 90" className="gauge-track" />
        {/* No reading, no fill: a zero-length round-capped stroke would still draw a dot at 0. */}
        {share > 0 && <path d="M 20 90 A 70 70 0 0 1 160 90" className="gauge-fill" strokeDasharray={`${len * share} ${len}`} />}
      </svg>
      <div className="gauge-read">
        <b>{value === undefined ? "—" : value.toFixed(1)}</b>
        <span>tok/s</span>
      </div>
      <div className="gauge-scale">
        <span>0</span>
        <span>{max}</span>
      </div>
    </div>
  );
}
