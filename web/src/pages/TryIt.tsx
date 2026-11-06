import { useEffect, useMemo, useState } from "react";
import { getSamples, outputText, type ItemResult } from "../api";
import { getRuns, hbar, REPLAY, startRun, type ModelListing, type Run } from "../data";
import type { Snapshot } from "../live";

// "Try it" on a model page: a real, paid, checked job on the model, from a few lines of text.
// The steps come from the job's own HCS receipts as they land.

const MAX_LINES = 8;

export default function TryIt({ snap, m, serving }: { snap: Snapshot; m: ModelListing; serving: number }) {
  const [text, setText] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    getSamples(m.key)
      .then((s) => alive && setText((t) => t || s.texts.slice(0, 4).join("\n")))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [m.key]);

  // Poll the agent for this run until it ends.
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    const tick = async () => {
      try {
        const r = (await getRuns()).runs.find((x) => x.runId === runId) ?? null;
        if (alive) setRun(r);
        if (r && ["complete", "incomplete", "failed", "halted"].includes(r.status)) return;
      } catch {
        // Keep the last state; try again.
      }
      if (alive) setTimeout(tick, 2500);
    };
    void tick();
    return () => {
      alive = false;
    };
  }, [runId]);

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, MAX_LINES);
  const selfHosted = m.card.runtime.engine === "openai";

  const go = async () => {
    setBusy(true);
    setError(null);
    setRun(null);
    try {
      // A small model answers best one item at a time; 0G's model takes a few per chunk.
      const r = await startRun({ model: m.key, texts: lines, items: lines.length, chunkSize: selfHosted ? 1 : 2, maxSpendTinybar: "50000000", maxPriceTinybar: "500000" });
      setRunId(r.runId);
      setRun(r);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const jobId = run?.jobId;
  const r = useMemo(() => (jobId ? snap.receipts.filter((x) => x.job === jobId) : []), [snap.receipts, jobId]);
  const chunks = jobId ? snap.chunks.filter((c) => c.attrs.job_id === jobId) : [];
  const total = Math.max(1, Math.ceil(lines.length / (selfHosted ? 1 : 2)));
  const paid = r.filter((x) => x.t === "chunk").length;
  const known = r.filter((x) => x.t === "known");
  const canaries = r.filter((x) => x.t === "canary");
  const checksPassed = [...known, ...canaries].filter((x) => x.pass).length;
  const checksFailed = [...known, ...canaries].filter((x) => !x.pass).length;
  const royalty = r.find((x) => x.t === "royalty");
  const done = r.find((x) => x.t === "done");
  const ended = run && ["complete", "incomplete", "failed", "halted"].includes(run.status);
  const results = ((run?.report as { results?: ItemResult[] } | undefined)?.results ?? []) as ItemResult[];
  const inputs = run && results.length ? lines : [];

  type S = "done" | "active" | "todo" | "bad";
  const steps: { label: string; detail?: string; s: S }[] = [
    { label: "GPU admitted", detail: "known-answer probe on this model", s: jobId ? "done" : run ? "active" : "todo" },
    { label: "Rules committed on Hedera", detail: "hidden checks locked in before any work", s: r.some((x) => x.t === "job") ? "done" : jobId ? "active" : "todo" },
    { label: `Chunks paid over x402`, detail: `${paid} of ${total}`, s: paid >= total || done ? "done" : paid > 0 || chunks.length ? "active" : "todo" },
    {
      label: "Hidden checks",
      detail: checksPassed + checksFailed ? `${checksPassed} passed${checksFailed ? ` · ${checksFailed} failed, rerouted or refunded` : ""}` : "known answers and 0G canaries",
      s: checksFailed && !done ? "bad" : done ? "done" : checksPassed ? "active" : "todo",
    },
    { label: "Settled", detail: done ? `paid ${hbar(done.paid as string)} · refunded ${hbar(done.refunded as string)}` : undefined, s: done ? "done" : ended ? "bad" : "todo" },
    { label: "Creator paid", detail: royalty ? `${hbar(royalty.amount as string)} royalty` : `${m.card.royaltyBps / 100}% of accepted chunks`, s: royalty ? "done" : ended && !royalty ? "todo" : "todo" },
  ];

  return (
    <div className="try">
      <div className="try-head">
        <div>
          <h3>Try it</h3>
          <p className="muted small">A real job: paid per chunk, checked against hidden answers, refunded if a GPU cheats.</p>
        </div>
        <span className="tag">{serving ? `${serving} GPU${serving === 1 ? "" : "s"} serving` : "no GPU serving"}</span>
      </div>

      <textarea className="try-input" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="One input per line" disabled={busy || (!!run && !ended)} />
      <div className="try-bar">
        <span className="muted small">
          {lines.length} line{lines.length === 1 ? "" : "s"} · max {MAX_LINES} · budget 0.5 ℏ
        </span>
        <button className="btn primary" onClick={go} disabled={busy || lines.length === 0 || serving === 0 || REPLAY || (!!run && !ended)}>
          {busy ? "Starting…" : run && !ended ? "Running…" : "Run on KINETIC"}
        </button>
      </div>
      {REPLAY && <p className="muted small">The replay can't run jobs. Switch to live to try a model.</p>}
      {error && <div className="banner">{error}</div>}

      {run && (
        <div className="try-run">
          <ol className="stepper">
            {steps.map((s) => (
              <li key={s.label} className={s.s}>
                <span className="dot" aria-hidden>
                  {s.s === "done" ? "✓" : s.s === "bad" ? "!" : ""}
                </span>
                <span>
                  <b>{s.label}</b>
                  {s.detail && <span className="d">{s.detail}</span>}
                </span>
              </li>
            ))}
          </ol>

          {run.error && <div className="banner">{run.error}</div>}

          {results.length > 0 && (
            <div className="files-wrap" style={{ marginTop: 14 }}>
              <table className="files try-results">
                <thead>
                  <tr>
                    <th>Input</th>
                    <th>Output</th>
                  </tr>
                </thead>
                <tbody>
                  {inputs.map((input, i) => (
                    <tr key={i}>
                      <td>{input}</td>
                      <td className="out">{outputText(results.find((x) => x.id === String(i + 1)))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {ended && jobId && (
            <div className="try-foot">
              <span className={run.status === "complete" ? "verified" : "warn"}>{run.status === "complete" ? "✓ Every chunk checked and accepted" : `Job ${run.status}: ${(run.report?.outcome?.notes ?? []).join(" · ")}`}</span>
              <a className="btn" href={`#/jobs/${encodeURIComponent(jobId)}`}>
                Job & Compute Passport →
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
