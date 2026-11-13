import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, Check, ShieldCheck } from "lucide-react";
import { getModelPassport, hbar, listingsOf, REPLAY, short, storageLink, type Entity, type ModelListing, type ModelPassport } from "../data";
import { useLive, type Snapshot } from "../live";
import { StatusTag, TxLink } from "../ui";
import { verifyPassportInBrowser, verifyPassportStored, type BrowserCheck } from "../verify";
import TryIt from "./TryIt";
import Chat from "./Chat";

// The model hub: every model listed by the bond vault's verifiers, each with a Model Passport
// signed by a quorum of them. Read from Arkiv, HCS and 0G Storage; the passport is re-checked here.

/** Live offers that serve a model, and what its jobs paid its creator. */
function useModelStats(snap: Snapshot) {
  return useMemo(() => {
    const serving = new Map<string, Entity[]>();
    for (const o of snap.offers) {
      for (const k of Object.keys(o.attrs)) {
        if (!k.startsWith("model.")) continue;
        const key = k.slice(6);
        serving.set(key, [...(serving.get(key) ?? []), o]);
      }
    }
    const royalties = new Map<string, { total: number; jobs: number }>();
    for (const r of snap.receipts) {
      if (r.t !== "royalty") continue;
      const m = String(r.model);
      const cur = royalties.get(m) ?? { total: 0, jobs: 0 };
      royalties.set(m, { total: cur.total + Number(r.amount), jobs: cur.jobs + 1 });
    }
    const jobs = new Map<string, Entity[]>();
    for (const j of snap.jobs) if (j.attrs.model) jobs.set(String(j.attrs.model), [...(jobs.get(String(j.attrs.model)) ?? []), j]);
    return { serving, royalties, jobs };
  }, [snap.offers, snap.receipts, snap.jobs]);
}

const TASK_NAME = { classify: "Text classification", extract: "Information extraction", tag: "Multi-label tagging" } as const;

const size = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024).toLocaleString("en-US", { maximumFractionDigits: 1 })} KB`;

const AVATAR = ["#059669", "#2563eb", "#d97706", "#7c3aed", "#db2777", "#0891b2"];

export function Avatar({ m, lg }: { m: ModelListing; lg?: boolean }) {
  const name = m.card.id.split("/").pop() ?? m.card.id;
  const hue = [...m.card.id].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR.length;
  return (
    <span className={`avatar ${lg ? "lg" : ""}`} style={{ background: AVATAR[hue] }} aria-hidden>
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}

/** One entry per model id, its newest version (older ones are on the model's page). */
export const latestPerId = (listings: ModelListing[]) => {
  const newest = new Map<string, ModelListing>();
  for (const m of listings) {
    const cur = newest.get(m.card.id);
    if (!cur || cur.card.version.localeCompare(m.card.version, undefined, { numeric: true }) < 0) newest.set(m.card.id, m);
  }
  return [...newest.values()];
};

/** Where a listing keeps its weights, if it publishes any. */
const storeOf = (m: ModelListing): "0G Storage" | null => ((m.card.weights?.files ?? []).some((f) => f.zgRoot) ? "0G Storage" : null);

const Icon = {
  check: (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.7-9.3a1 1 0 0 0-1.4-1.4L9 10.6 7.7 9.3a1 1 0 0 0-1.4 1.4l2 2a1 1 0 0 0 1.4 0l4-4Z" />
    </svg>
  ),
  gpu: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
    </svg>
  ),
  chart: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M3 3v18h18M7 15l4-4 3 3 5-6" />
    </svg>
  ),
  coin: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v10M9.5 9.5h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4" />
    </svg>
  ),
  box: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M21 8 12 3 3 8v8l9 5 9-5V8ZM3 8l9 5 9-5M12 13v8" />
    </svg>
  ),
};

/** One model as a row: who made it, how well it scored, who serves it, and a way to run it. */
function ModelRow({ m, serving, jobs }: { m: ModelListing; serving: number; jobs: number }) {
  const [ns, name] = m.card.id.split("/");
  const store = storeOf(m);
  return (
    <article className="hrow">
      <Avatar m={m} />
      <div className="hrow-main">
        <div className="hrow-id">
          <a href={`#/models/${m.key}`}>
            <span className="ns">{ns}/</span>
            {name}
          </a>
          <span className="hrow-verified" title={`Model Passport signed by ${m.signers.length} verifiers`}>
            <ShieldCheck size={13} strokeWidth={1.75} aria-hidden /> Verified
          </span>
        </div>
        {m.card.description && <p className="hrow-desc">{m.card.description}</p>}
        <div className="hrow-pills">
          <span className="pill">v{m.card.version}</span>
          <span className="pill">{m.card.runtime.engine === "0g" ? "0G Compute" : "Provider GPUs"}</span>
          <span className="pill">{store ?? "Hosted by 0G"}</span>
          <span className="pill" title="Creator's share of every accepted chunk">
            {(m.card.royaltyBps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}% royalty
          </span>
        </div>
      </div>
      <dl className="hrow-stats">
        <div title="Benchmark on the verifiers' held-out examples">
          <dt>Benchmark</dt>
          <dd>{Math.round(m.accuracy * 100)}%</dd>
        </div>
        <div title="Providers serving it now">
          <dt>GPUs</dt>
          <dd>{serving}</dd>
        </div>
        <div title="Jobs that ran this model">
          <dt>Jobs</dt>
          <dd>{jobs}</dd>
        </div>
      </dl>
      <a className="hrow-go" href={`#/run/${m.key}`} aria-label={`Run ${m.card.name}`}>
        <span>Run</span>
        <ArrowRight size={15} strokeWidth={1.75} aria-hidden />
      </a>
    </article>
  );
}

type Facet<T extends string> = { title: string; value: T | "all"; set: (v: T | "all") => void; options: [T, string][]; count: (v: T) => number };

function FacetGroup<T extends string>({ title, value, set, options, count }: Facet<T>) {
  return (
    <div className="facet">
      <h4>{title}</h4>
      <div className="fopts">
        {options.map(([v, text]) => (
          <button key={v} className="fopt" aria-pressed={value === v} disabled={count(v) === 0 && value !== v} onClick={() => set(value === v ? "all" : v)}>
            <span className="box" aria-hidden>
              <Check size={11} strokeWidth={3} />
            </span>
            {text}
            <span className="n">{count(v)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function ModelList({ snap, query = "" }: { snap: Snapshot; query?: string }) {
  const listings = latestPerId(listingsOf(snap.status, snap.models));
  const stats = useModelStats(snap);
  const [q, setQ] = useState(query);
  const [task, setTask] = useState<"classify" | "extract" | "tag" | "all">("all");
  const [runtime, setRuntime] = useState<"0g" | "openai" | "all">("all");
  const [store, setStore] = useState<"0g" | "none" | "all">("all");
  const [sort, setSort] = useState<"used" | "accuracy" | "name">("used");
  const served = (m: ModelListing) => stats.serving.get(m.key)?.length ?? 0;
  const used = (m: ModelListing) => stats.jobs.get(m.key)?.length ?? 0;

  const storeIs = (m: ModelListing, s: "0g" | "none") => (s === "0g" ? storeOf(m) === "0G Storage" : !storeOf(m));
  const shown = listings
    .filter((m) => task === "all" || m.card.task.kind === task)
    .filter((m) => runtime === "all" || m.card.runtime.engine === runtime)
    .filter((m) => store === "all" || storeIs(m, store))
    .filter((m) => !q || `${m.card.name} ${m.card.id} ${m.card.description}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (sort === "name" ? a.card.id.localeCompare(b.card.id) : sort === "accuracy" ? b.accuracy - a.accuracy : used(b) - used(a) || served(b) - served(a)));

  return (
    <div className="page">
      <header className="ak-page-head">
        <h1>Models</h1>
        <p>Verified models, ready to run on community GPUs.</p>
      </header>
      <div className="hub">
        <aside className="facets" aria-label="Filters">
          <FacetGroup
            title="Tasks"
            value={task}
            set={setTask}
            count={(v) => listings.filter((m) => m.card.task.kind === v).length}
            options={[
              ["classify", "Classification"],
              ["extract", "Extraction"],
              ["tag", "Tagging"],
            ]}
          />
          <FacetGroup
            title="Runs on"
            value={runtime}
            set={setRuntime}
            count={(v) => listings.filter((m) => m.card.runtime.engine === v).length}
            options={[
              ["0g", "0G Compute"],
              ["openai", "Provider GPUs"],
            ]}
          />
          <FacetGroup
            title="Weights"
            value={store}
            set={setStore}
            count={(v) => listings.filter((m) => storeIs(m, v)).length}
            options={[
              ["0g", "0G Storage"],
              ["none", "Hosted by 0G"],
            ]}
          />
          <div className="facet-cta">
            <p>Built a model worth sharing?</p>
            <a className="btn" href="#/publish">
              Publish a model
            </a>
          </div>
        </aside>

        <section>
          <div className="hub-head">
            <h2>
              All models<span className="count">{shown.length}</span>
            </h2>
            <input className="hub-search" type="search" placeholder="Filter by name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter models by name" />
            <select className="hub-sort" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
              <option value="used">Most used</option>
              <option value="accuracy">Highest benchmark</option>
              <option value="name">Name</option>
            </select>
          </div>
          {shown.length === 0 ? (
            <div className="empty-hub">{listings.length === 0 ? "No models listed yet." : "No models match these filters."}</div>
          ) : (
            <div className="mlist">
              {(Object.keys(TASK_NAME) as (keyof typeof TASK_NAME)[]).map((kind) => {
                const group = shown.filter((m) => m.card.task.kind === kind);
                if (group.length === 0) return null;
                return (
                  <section key={kind} className="mgroup" aria-label={TASK_NAME[kind]}>
                    <h3 className="mgroup-pill">{TASK_NAME[kind]}</h3>
                    {group.map((m) => (
                      <ModelRow key={m.key} m={m} serving={served(m)} jobs={used(m)} />
                    ))}
                  </section>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

type Tab = "card" | "try" | "chat" | "files" | "passport" | "jobs";

export function ModelDetail({ snap, modelKey }: { snap: Snapshot; modelKey: string }) {
  const { label } = useLive();
  const listings = listingsOf(snap.status, snap.models);
  const m = listings.find((l) => l.key === modelKey);
  const stats = useModelStats(snap);
  const [tab, setTab] = useState<Tab>("card");
  const [passport, setPassport] = useState<ModelPassport | null>(null);
  const [checks, setChecks] = useState<BrowserCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState("");

  useEffect(() => {
    if (!m) return;
    let alive = true;
    setPassport(null);
    setChecks(null);
    getModelPassport(m)
      .then(async (p) => {
        if (!alive) return;
        setPassport(p);
        if (!REPLAY) {
          const c = await verifyPassportInBrowser(p, m, snap.status.quorum);
          if (alive) setChecks(c);
          // Then the copy on 0G Storage, by the root the listing names.
          const stored = await verifyPassportStored(m);
          if (alive) setChecks([...c, stored]);
        }
      })
      .catch((err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
    };
    // Re-check when the listing points to a different passport, not on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m?.key, m?.passportDigest]);

  if (!m) {
    return (
      <div className="page">
        <div className="empty-hub">
          No model with key <span className="mono">{modelKey}</span>. It may still be under review.{" "}
          <a className="link" href="#/models">
            All models
          </a>
        </div>
      </div>
    );
  }

  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(""), 1500);
  };
  const [ns, name] = m.card.id.split("/");
  const serving = stats.serving.get(m.key) ?? [];
  const earned = stats.royalties.get(m.key);
  const jobs = stats.jobs.get(m.key) ?? [];
  const versions = listings.filter((l) => l.card.id === m.card.id).sort((a, b) => b.card.version.localeCompare(a.card.version, undefined, { numeric: true }));
  const receipt = snap.receipts.find((r) => r.t === "model" && r.model === m.key);
  const failed = checks?.filter((c) => c.ok === false).length ?? 0;
  const t = m.card.task;
  const store = storeOf(m);
  const cheapest = serving.length ? Math.min(...serving.map((o) => Number(o.attrs.price))) : undefined;
  const passportLink = storageLink(snap.status, m.passportRef);
  const fileCount = m.card.weights?.files.length ?? 0;

  const TABS: [Tab, string, ReactNode?][] = [
    ["card", "Model card"],
    ["try", "Try it"],
    ["chat", "Chat"],
    ["files", "Files", fileCount || undefined],
    ["passport", "Passport", checks ? (failed ? `${failed} failed` : "✓") : undefined],
    ["jobs", "Jobs", jobs.length || undefined],
  ];

  return (
    <div className="page">
      <div className="mhead">
        <Avatar m={m} lg />
        <div style={{ minWidth: 0 }}>
          <div className="mhead-id">
            <span>
              <span className="ns">{ns}/</span>
              {name}
            </span>
            <button className="copy" onClick={() => copy(m.card.id, "id")} title="Copy model id">
              {copied === "id" ? "Copied" : "Copy"}
            </button>
            <span className="tag">v{m.card.version}</span>
          </div>
          <div className="mhead-sub">{m.card.name}</div>
          <div className="chips">
            <span className="chip">{TASK_NAME[t.kind]}</span>
            <span className="chip">{m.card.runtime.engine === "0g" ? "0G Compute" : "Provider GPUs"}</span>
            {store && <span className="chip">Weights on {store}</span>}
            <span className="chip">{m.card.license}</span>
            <span className="tag ok">{Icon.check} Verified by {m.signers.length} verifiers</span>
          </div>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {TABS.map(([id, text, n]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {text}
            {n !== undefined && <span className="n">{n}</span>}
          </button>
        ))}
      </div>

      <div className="mlayout">
        <div style={{ minWidth: 0 }}>
          {tab === "card" && (
            <div className="prose">
              <p>{m.card.description}</p>
              <h3>{t.kind === "extract" ? "Fields" : t.kind === "tag" ? "Tags" : "Labels"}</h3>
              <div className="chips">
                {(t.kind === "extract" ? t.fields ?? [] : t.labels ?? []).map((l) => (
                  <span key={l.name} className="chip" title={l.hint || undefined}>
                    {l.name}
                  </span>
                ))}
              </div>
              <h3>Use this model</h3>
              <pre className="cmd">{`npm run kinetic -- run --model ${m.card.id}@${m.card.version} --items tickets.jsonl`}</pre>
              <h3>Benchmark</h3>
              <p>
                {passport ? `${passport.benchmark.correct} of ${passport.benchmark.items}` : "…"} held-out examples right (<b>{Math.round(m.accuracy * 100)}%</b>); listing needs{" "}
                {passport ? Math.round(passport.benchmark.minAccuracy * 100) : 70}%.
              </p>
            </div>
          )}

          {tab === "try" && <TryIt snap={snap} m={m} serving={serving.length} />}
          {tab === "chat" && <Chat snap={snap} m={m} serving={serving.length} />}

          {tab === "files" &&
            (m.card.weights ? (
              <>
                <div className="files-wrap">
                  <table className="files">
                    <thead>
                      <tr>
                        <th>File</th>
                        <th className="num">Size</th>
                        <th>Stored on</th>
                        <th>sha256</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.card.weights.files.map((f) => (
                        <tr key={f.name}>
                          <td className="mono">{f.name}</td>
                          <td className="num">{size(f.bytes)}</td>
                          <td>
                            {f.zgRoot ? (
                              <button className="store" title={`0G Storage root ${f.zgRoot}: click to copy`} onClick={() => copy(f.zgRoot!, f.name)}>
                                {copied === f.name ? "Copied" : `0G · ${short(f.zgRoot, 4)}`}
                              </button>
                            ) : (
                              <span className="muted">source URL</span>
                            )}
                          </td>
                          <td className="mono muted" title={f.sha256}>
                            {f.sha256.slice(0, 12)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {passport?.weights.checked && (
                  <p className="small muted" style={{ marginTop: 12 }}>
                    {passport.weights.params.toLocaleString("en-US")} parameters · {passport.weights.dtypes.join(", ")} · malware checks {passport.weights.ok ? "passed" : "failed"}
                  </p>
                )}
              </>
            ) : (
              <div className="empty-hub">Runs on 0G Compute with no published weights. Its passport rests on the benchmark and fingerprint.</div>
            ))}

          {tab === "passport" && (
            <>
              {error && <div className="banner">Couldn't load the Model Passport: {error}</div>}
              {REPLAY && <div className="empty-hub">The replay's signatures are invented, so there's nothing to check here.</div>}
              {!REPLAY && !checks && !error && <p className="muted">Checking the passport in your browser…</p>}
              {checks && (
                <>
                  <p className="muted small" style={{ marginBottom: 8 }}>
                    Re-checked in your browser: digests and signatures, and the copy on 0G Storage.
                  </p>
                  <ul className="checks">
                    {checks.map((c) => (
                      <li key={c.name} className={c.ok === true ? "ok" : c.ok === false ? "bad" : "na"}>
                        <span className="ico" aria-hidden>
                          {c.ok === true ? "✓" : c.ok === false ? "✗" : "–"}
                        </span>
                        <span>
                          {c.name}
                          {c.detail && <span className="d">{c.detail}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {passport?.weights.checked && (
                <details className="more">
                  <summary>Malware checks on the weights</summary>
                  <ul>
                    {passport.weights.checks.map((c) => (
                      <li key={c.name} className={c.ok ? "" : "bad"}>
                        {c.ok ? "✓" : "✗"} {c.name}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {passport && (
                <details className="more">
                  <summary>What the passport doesn't prove</summary>
                  <ul>
                    {passport.limitations.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}

          {tab === "jobs" &&
            (jobs.length === 0 ? (
              <div className="empty-hub">No jobs have run this model yet.</div>
            ) : (
              <div className="panel">
                {jobs.slice(0, 20).map((j) => (
                  <a key={j.key} className="job-card" href={`#/jobs/${encodeURIComponent(String(j.attrs.job_id))}`}>
                    <div className="job-card-head">
                      <span className="mono">{short(String(j.attrs.job_id), 12)}</span>
                      <StatusTag status={String(j.attrs.status)} />
                    </div>
                    <div className="meta">
                      {Number(j.attrs.done)}/{Number(j.attrs.total)} chunks{j.attrs.royalty ? ` · ${hbar(j.attrs.royalty as number)} royalty` : ""}
                    </div>
                  </a>
                ))}
              </div>
            ))}
        </div>

        <aside className="side">
          <div className="side-card">
            <button className="btn primary" onClick={() => setTab("try")} disabled={serving.length === 0}>
              Try it
            </button>
            <a className="btn" href={`#/run/${m.key}`} style={{ marginTop: 8 }}>
              Run a full job
            </a>
            <p className="small muted" style={{ marginTop: 10, textAlign: "center" }}>
              {serving.length ? `${serving.length} GPU${serving.length === 1 ? "" : "s"} · from ${hbar(cheapest)} per chunk` : "No GPU serving it right now"}
            </p>
          </div>

          <div className="side-card">
            <div className="side-stats">
              <div>
                <b>{Math.round(m.accuracy * 100)}%</b>
                <span>Benchmark</span>
              </div>
              <div>
                <b>{m.card.royaltyBps / 100}%</b>
                <span>Creator royalty</span>
              </div>
              <div>
                <b>{earned ? hbar(earned.total) : "0 ℏ"}</b>
                <span>Paid to creator</span>
              </div>
              <div>
                <b>{jobs.length}</b>
                <span>Jobs run</span>
              </div>
            </div>
          </div>

          {serving.length > 0 && (
            <div className="side-card">
              <h4>Serving it now</h4>
              <ul className="side-list">
                {serving.map((o) => (
                  <li key={o.key}>
                    <span>{label(String(o.attrs.provider))}</span>
                    <span className="muted">{hbar(o.attrs.price as number)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="side-card">
            <h4>Proof</h4>
            <ul className="side-list">
              <li>
                <span className="muted">Creator</span>
                <span className="mono">{short(m.card.creator.address, 4)}</span>
              </li>
              <li>
                <span className="muted">HCS receipt</span>
                {receipt ? <TxLink status={snap.status} kind="topic" id={snap.status.hcsTopic} text={`#${receipt.seq}`} /> : <span>—</span>}
              </li>
              <li>
                <span className="muted">Passport</span>
                {passportLink ? (
                  <a className="ext mono" href={passportLink} target="_blank" rel="noreferrer" title="On 0G Storage">
                    {short(m.passportRef, 4)}
                  </a>
                ) : (
                  <span className="mono">{short(m.passportRef, 4)}</span>
                )}
              </li>
              <li>
                <span className="muted">Signed by</span>
                <span>{m.signers.length} verifiers</span>
              </li>
            </ul>
          </div>

          {versions.length > 1 && (
            <div className="side-card">
              <h4>Versions</h4>
              <ul className="side-list">
                {versions.map((v) => (
                  <li key={v.key}>
                    {v.key === m.key ? <b>v{v.card.version}</b> : <a className="link" href={`#/models/${v.key}`}>v{v.card.version}</a>}
                    <span className="muted">
                      {Math.round(v.accuracy * 100)}% · {v.card.royaltyBps / 100}%
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
