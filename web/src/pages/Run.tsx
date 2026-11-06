import { useEffect, useMemo, useState } from "react";
import { getAgentInfo, getRuns, hbar, listingsOf, money, paymentSymbol, setHalted, short, startRun, toUnits, type AgentInfo, type Run as AgentRun, type Strategy, type Tier } from "../data";
import { go, type Snapshot } from "../live";
import { StatusTag } from "../ui";
import { Avatar } from "./Models";

type Mode = "model" | "task";
type Source = "sample" | "own";

const TIERS: [Tier, string, string][] = [
  ["basic", "Basic", "Signed receipts and format checks, for a fifth of the fee."],
  ["standard", "Standard", "Known answers in every chunk and hidden 0G canaries."],
  ["high", "High", "Two independent providers must agree on every chunk (pays twice)."],
  ["confidential", "Confidential", "TeeML-attested 0G nodes only."],
];

export default function Run({ snap, modelKey }: { snap: Snapshot; modelKey?: string }) {
  // Models some GPU serves right now come first, so the default is one that can actually run.
  const served = (key: string) => snap.offers.some((o) => o.attrs[`model.${key}`] !== undefined);
  const listings = listingsOf(snap.status, snap.models).sort((a, b) => Number(served(b.key)) - Number(served(a.key)));
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [halted, setHaltedState] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(modelKey || listings.length ? "model" : "task");
  const [model, setModel] = useState(modelKey ?? listings[0]?.key ?? "");
  const [source, setSource] = useState<Source>("sample");
  const [texts, setTexts] = useState("");
  // checkPct, passPct and deadlineMin: 0 means "the network's own rule" / "no deadline".
  const [form, setForm] = useState({ preset: "", items: 24, chunkSize: 3, maxPrice: "0.005", maxSpend: "0.5", strategy: "balanced" as Strategy, maxProviders: 0, checkPct: 0, passPct: 0, deadlineMin: 0, tier: "standard" as Tier });
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (modelKey) {
      setMode("model");
      setModel(modelKey);
    }
  }, [modelKey]);
  useEffect(() => {
    if (!model && listings[0]) setModel(listings[0].key);
  }, [listings, model]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [i, r] = await Promise.all([getAgentInfo(), getRuns()]);
        if (!alive) return;
        setInfo(i);
        setRuns(r.runs);
        setHaltedState(r.halted);
        setAgentError(null);
        setForm((f) => (f.preset ? f : { ...f, preset: i.presets[0]?.id ?? "" }));
      } catch (err) {
        if (alive) setAgentError((err as Error).message);
      }
    };
    tick();
    const t = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const selected = mode === "model" ? listings.find((l) => l.key === model) : undefined;
  const own = texts
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);
  const items = source === "own" ? own.length : form.items;
  const chunks = Math.ceil(items / Math.max(1, form.chunkSize));
  // Only providers that serve the chosen model can take a model job.
  const offers = useMemo(() => (selected ? snap.offers.filter((o) => o.attrs[`model.${selected.key}`] !== undefined) : snap.offers), [snap.offers, selected]);
  const eligible = offers.map((o) => Number(o.attrs.price)).filter((p) => p <= Number(toUnits(snap.status, form.maxPrice)));
  const cheapest = eligible.length ? Math.min(...eligible) : null;
  const scale = { basic: 0.2, standard: 1, high: 1.5, confidential: 1.25 }[form.tier];
  const fee = Math.ceil(Number(snap.status.earnings.feePerChunkTinybar) * chunks * scale);
  const work = cheapest === null ? null : cheapest * chunks * (form.tier === "high" ? 2 : 1);
  const royalty = work === null || !selected ? 0 : Math.ceil((work * selected.card.royaltyBps) / 10_000);
  const estimate = work === null ? null : work + fee + royalty;
  const overBudget = estimate !== null && estimate > Number(toUnits(snap.status, form.maxSpend));
  const maxItems = info?.maxItems ?? 120;
  const blocked = busy || halted || items === 0 || (mode === "model" ? !selected : !form.preset) || (source === "own" && own.length > maxItems);
  const sym = paymentSymbol(snap.status);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setSubmitError(null);
    try {
      const run = await startRun({
        ...(mode === "model" && selected ? { model: selected.key } : { preset: form.preset }),
        ...(source === "own" ? { texts: own } : {}),
        items,
        chunkSize: form.chunkSize,
        maxPriceTinybar: toUnits(snap.status, form.maxPrice),
        maxSpendTinybar: toUnits(snap.status, form.maxSpend),
        strategy: form.strategy,
        ...(form.maxProviders > 0 ? { maxProviders: form.maxProviders } : {}),
        agreement: {
          ...(form.checkPct > 0 ? { canaryRate: form.checkPct / 100 } : {}),
          ...(form.passPct > 0 ? { minAgreement: form.passPct / 100 } : {}),
          ...(form.deadlineMin > 0 ? { deadlineSeconds: form.deadlineMin * 60 } : {}),
          tier: form.tier,
        },
      });
      setRuns((rs) => [run, ...rs.filter((r) => r.runId !== run.runId)]);
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const labels = selected ? (selected.card.task.kind === "extract" ? selected.card.task.fields ?? [] : selected.card.task.labels ?? []) : [];

  return (
    <div className="page pg">
      <div className="phead pg-bar">
        <h1 className="sr-only">Run a job</h1>
        <span className="small muted">{snap.offers.length} GPUs online</span>
      </div>

      {agentError && !info ? (
        <div className="empty-hub">
          <h3 style={{ color: "var(--ink)", fontSize: 16, marginBottom: 6 }}>The buyer agent isn't reachable</h3>
          <p className="small" title={agentError}>
            Start it with <code>npm run live -- --serve</code> (port 4600).
          </p>
        </div>
      ) : (
        <div className="mlayout">
          <form id="run-form" className="card" onSubmit={submit} style={{ minWidth: 0 }}>
            <section className="fsec">
              <div className="fsec-head">
                <h3>{mode === "model" ? "Model" : "Task"}</h3>
                <div className="seg" role="tablist" aria-label="What to run">
                  <button type="button" role="tab" aria-selected={mode === "model"} className={mode === "model" ? "on" : ""} onClick={() => setMode("model")} disabled={listings.length === 0}>
                    Listed model
                  </button>
                  <button type="button" role="tab" aria-selected={mode === "task"} className={mode === "task" ? "on" : ""} onClick={() => setMode("task")}>
                    Built-in task
                  </button>
                </div>
              </div>
              <div className="form">
                {mode === "model" ? (
                  <label className="full">
                    <span className="sr-only">Model</span>
                    <select value={model} onChange={(e) => setModel(e.target.value)}>
                      {listings.map((l) => (
                        <option key={l.key} value={l.key}>
                          {l.card.id} · v{l.card.version}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label className="full">
                    <span className="sr-only">Task</span>
                    <select value={form.preset} onChange={(e) => setForm({ ...form, preset: e.target.value })}>
                      {info?.presets.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.id} ({p.kind})
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              {selected && (
                <div className="pick">
                  <Avatar m={selected} />
                  <div className="pick-main">
                    <div className="mrow-id">
                      <a href={`#/models/${selected.key}`}>
                        <span className="ns">{selected.card.id.split("/")[0]}/</span>
                        {selected.card.id.split("/")[1]}
                      </a>
                    </div>
                    <div className="mrow-meta">
                      <span className="verified" title={`Every chunk is signed for this exact model · Model Passport signed by ${selected.signers.length} verifiers`}>
                        ✓ Verified
                      </span>
                      <span title="Benchmark on the verifiers' held-out examples">{Math.round(selected.accuracy * 100)}% benchmark</span>
                      <span title="Creator's share of accepted chunks. Never charged on refunds.">{selected.card.royaltyBps / 100}% royalty</span>
                      <span className={offers.length ? "" : "warn"}>{offers.length ? `${offers.length} GPUs serving` : "No GPU serving it"}</span>
                    </div>
                    {labels.length > 0 && (
                      <div className="chips">
                        {labels.map((l) => (
                          <span key={l.name} className="chip">
                            {l.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </section>

            <section className="fsec">
              <div className="fsec-head">
                <h3>Data</h3>
                <div className="seg" role="tablist" aria-label="Data">
                  <button type="button" role="tab" aria-selected={source === "sample"} className={source === "sample" ? "on" : ""} onClick={() => setSource("sample")}>
                    Sample items
                  </button>
                  <button type="button" role="tab" aria-selected={source === "own"} className={source === "own" ? "on" : ""} onClick={() => setSource("own")}>
                    Paste my own
                  </button>
                </div>
              </div>
              <div className="form">
                {source === "sample" ? (
                  <label>
                    <span className="label">Items</span>
                    <input type="number" min={1} max={maxItems} value={form.items} onChange={(e) => setForm({ ...form, items: Number(e.target.value) })} title={`Up to ${maxItems}`} />
                  </label>
                ) : (
                  <label className="full">
                    <span className="label row-between">
                      One item per line
                      <span className={own.length > maxItems ? "bad" : "muted"} style={{ fontWeight: 400 }}>
                        {own.length}/{maxItems}
                      </span>
                    </span>
                    <textarea rows={6} value={texts} onChange={(e) => setTexts(e.target.value)} placeholder={"I was charged twice for my order\nThe app crashes when I open settings"} />
                  </label>
                )}
                <label>
                  <span className="label">Items per chunk</span>
                  <input type="number" min={1} max={20} value={form.chunkSize} onChange={(e) => setForm({ ...form, chunkSize: Number(e.target.value) })} />
                </label>
              </div>
            </section>

            <section className="fsec">
              <div className="fsec-head">
                <h3>Budget</h3>
              </div>
              <div className="form">
                <label>
                  <span className="label">Max price per chunk ({sym})</span>
                  <input inputMode="decimal" value={form.maxPrice} onChange={(e) => setForm({ ...form, maxPrice: e.target.value })} />
                </label>
                <label>
                  <span className="label">Job budget ({sym})</span>
                  <input inputMode="decimal" value={form.maxSpend} onChange={(e) => setForm({ ...form, maxSpend: e.target.value })} />
                </label>
              </div>
            </section>

            <section className="fsec">
              <div className="fsec-head">
                <h3>Assurance</h3>
              </div>
              <div className="seg" role="radiogroup" aria-label="Assurance">
                {TIERS.map(([id, text, hint]) => (
                  <button key={id} type="button" role="radio" aria-checked={form.tier === id} className={form.tier === id ? "on" : ""} title={hint} onClick={() => setForm({ ...form, tier: id })}>
                    {text}
                  </button>
                ))}
              </div>
              <p className="hint">{TIERS.find((t) => t[0] === form.tier)?.[2]}</p>
            </section>

            <details className="more fsec">
              <summary>Advanced rules</summary>
              <div className="form">
                <label>
                  <span className="label">Provider choice</span>
                  <select value={form.strategy} onChange={(e) => setForm({ ...form, strategy: e.target.value as Strategy })}>
                    <option value="cheapest">Cheapest first</option>
                    <option value="balanced">Balanced (price, track record, speed)</option>
                    <option value="fastest">Fastest first</option>
                  </select>
                </label>
                <label>
                  <span className="label" title="0 uses every eligible provider">
                    Providers at once
                  </span>
                  <input type="number" min={0} max={20} value={form.maxProviders} onChange={(e) => setForm({ ...form, maxProviders: Math.max(0, Number(e.target.value)) })} />
                </label>
                <label>
                  <span className="label" title={`0 uses the network's rate (${Math.round(snap.status.policy.canaryRate * 100)}%)`}>
                    Checked chunks %
                  </span>
                  <input type="number" min={0} max={100} value={form.checkPct} onChange={(e) => setForm({ ...form, checkPct: Math.max(0, Math.min(100, Number(e.target.value))) })} />
                </label>
                <label>
                  <span className="label" title={`0 uses the network's pass mark (${Math.round(snap.status.policy.minAgreement * 100)}%)`}>
                    Pass mark %
                  </span>
                  <input type="number" min={0} max={100} value={form.passPct} onChange={(e) => setForm({ ...form, passPct: Math.max(0, Math.min(100, Number(e.target.value))) })} />
                </label>
                <label className="full">
                  <span className="label" title="0 means no deadline">
                    Deadline (minutes)
                  </span>
                  <input type="number" min={0} value={form.deadlineMin} onChange={(e) => setForm({ ...form, deadlineMin: Math.max(0, Number(e.target.value)) })} />
                </label>
              </div>
              <p className="hint" title="Your pass mark sets what you accept. Slashing follows network rules.">
                0 uses the network default. Rules are hashed to HCS before work starts.
              </p>
            </details>
          </form>

          <aside className="side">
            <div className="side-card">
              <h4>Estimate</h4>
              <div className={`est ${estimate === null ? "none" : overBudget ? "bad" : ""}`}>{estimate === null ? "No offer under your price" : `≥ ${money(snap.status, estimate)}`}</div>
              <div className="est-sub">
                {items} items · {chunks} chunks
              </div>
              {estimate !== null && (
                <ul className="side-list">
                  <li>
                    <span className="muted">Providers</span>
                    <span>{money(snap.status, work!)}</span>
                  </li>
                  <li>
                    <span className="muted">Verifier fee</span>
                    <span>{money(snap.status, fee)}</span>
                  </li>
                  {selected && (
                    <li>
                      <span className="muted">Creator royalty</span>
                      <span>up to {money(snap.status, royalty)}</span>
                    </li>
                  )}
                </ul>
              )}
              {overBudget && <p className="small bad" style={{ marginTop: 10 }}>Over your job budget.</p>}
              {submitError && (
                <div className="banner" style={{ marginTop: 12 }}>
                  {submitError}
                </div>
              )}
              <button type="submit" form="run-form" className="btn primary lg" disabled={blocked}>
                {busy ? "Starting…" : mode === "model" ? "Run via KINETIC" : "Start job"}
              </button>
              <button type="button" className={`stop ${halted ? "on" : ""}`} onClick={() => setHalted(!halted).then((r) => setHaltedState(r.halted))}>
                {halted ? "Halted · resume paid work" : "Stop all paid work"}
              </button>
            </div>

            <div className="side-card">
              <h4>
                Your runs <span className="muted" style={{ fontWeight: 400 }}>{runs.length || ""}</span>
              </h4>
              {runs.length === 0 ? (
                <p className="small muted">Nothing started from here yet.</p>
              ) : (
                <ul className="runs">
                  {runs.map((r) => (
                    <li key={r.runId} className={r.jobId ? "go" : ""} onClick={() => r.jobId && go(`jobs/${r.jobId}`)} title={`Budget ${money(snap.status, r.maxSpendTinybar)} · chunks of ${r.chunkSize}`}>
                      <div className="row-between">
                        <span className="mono">{r.jobId ? short(r.jobId, 10) : r.runId}</span>
                        <StatusTag status={r.status} />
                      </div>
                      <span>
                        {r.model ? `${r.model.id}@${r.model.version}` : r.preset} · {r.items} items · {new Date(r.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                      {r.error && <span className="bad">{r.error}</span>}
                      {r.report?.outcome && (
                        <span className={r.report.outcome.met ? "" : "bad"} title={r.report.outcome.notes.join("; ")}>
                          Agreement {r.report.outcome.met ? "met" : "not met"}
                          {r.report.outcome.met ? "" : `: ${r.report.outcome.notes.join("; ")}`}
                        </span>
                      )}
                      {r.report?.model?.royalty && <span className="ok">{hbar(r.report.model.royalty.amount)} royalty to the creator</span>}
                      {r.report?.passport && (
                        <span onClick={(e) => e.stopPropagation()}>
                          <a className="ext" href={r.report.passport.url} target="_blank" rel="noreferrer">
                            Compute Passport
                          </a>{" "}
                          · {r.report.passport.attested ? "co-signed" : "buyer-signed only"} · {r.report.passport.coverage.verified}/{r.report.chunks} checked on 0G
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
