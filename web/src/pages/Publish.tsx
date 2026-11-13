import { useEffect, useState, type ReactNode } from "react";
import { BrainCircuit, Check, Cloud, CloudUpload, Scale } from "lucide-react";
import { getPublish, getTemplates, startPublish, type PublishState, type Template } from "../api";
import { hashscan, listingsOf, short, storageLink, type ModelTask } from "../data";
import type { Snapshot } from "../live";

// Publish a model from the browser, then watch the verifier quorum review it, step by step,
// until it's listed with a Model Passport. On this testnet node the creator account signs the
// card and pays the listing fee; from the CLI, creators use their own key.

const TEMPLATE_NAMES: Record<string, string> = {
  "classify-tickets": "Support ticket routing",
  "extract-tickets": "Ticket field extraction",
  "animal-class": "Animal classification",
  intent: "Customer intent",
  "invoice-fields": "Invoice extraction",
  language: "Language detection",
  "news-topic": "News topics",
  sentiment: "Review sentiment",
  spam: "Spam filter",
  "ticket-fields": "Ticket field extraction",
  "ticket-tags": "Ticket tagging",
};

const KIND = { classify: "Classification", extract: "Extraction", tag: "Tagging" } as const;
const names = (t: ModelTask) => (t.kind === "extract" ? t.fields ?? [] : t.labels ?? []).map((l) => l.name);
const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

export default function Publish({ snap, resume }: { snap: Snapshot; resume?: string }) {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [creator, setCreator] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<string>("");
  const [form, setForm] = useState({ id: "", version: "1.0.0", name: "", description: "", license: "apache-2.0", royalty: 5 });
  const [state, setState] = useState<PublishState | null>(null);
  const [key, setKey] = useState<string | null>(resume ?? null);
  const [busy, setBusy] = useState(false);
  const listings = listingsOf(snap.status, snap.models);

  useEffect(() => {
    getTemplates()
      .then((t) => {
        setTemplates(t.templates);
        setCreator(t.creator);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  const template = templates?.find((t) => t.id === pick);
  // A version can't change once listed: suggest the next free one for this id.
  useEffect(() => {
    if (!form.id) return;
    const taken = listings.filter((l) => l.card.id === form.id).map((l) => l.card.version);
    if (!taken.includes(form.version)) return;
    const [a, b, c] = form.version.split(".").map(Number);
    let v = `${a}.${b}.${(c ?? 0) + 1}`;
    while (taken.includes(v)) v = `${a}.${b}.${Number(v.split(".")[2]) + 1}`;
    setForm((f) => ({ ...f, version: v }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.id, listings.length]);

  const choose = (t: Template) => {
    setPick(t.id);
    const name = TEMPLATE_NAMES[t.id] ?? t.id;
    setForm((f) => ({ ...f, id: f.id || `kinetic/${slugOf(name)}-pro`, name: f.name || `${name} Pro`, description: f.description || `${t.task.instructions}` }));
  };

  // Follow a publish until it's listed or refused.
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await getPublish(key);
        if (!alive) return;
        setState(s);
        if (s.status !== "publishing") return;
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
      if (alive) setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      alive = false;
    };
  }, [key]);

  const submit = async () => {
    if (!template) return;
    setBusy(true);
    setError(null);
    try {
      const s = await startPublish({ template: template.id, id: form.id, version: form.version, name: form.name, description: form.description, license: form.license, royaltyBps: Math.round(form.royalty * 100) });
      setState(s);
      setKey(s.key);
      history.replaceState(null, "", `#/publish/${s.key}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // What still stops the button, said plainly under it.
  const missing = !template
    ? "Choose a task template"
    : !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9._-]{0,63}$/.test(form.id)
      ? "Model id must look like namespace/name: lowercase letters, digits and dashes"
      : !/^\d+\.\d+\.\d+$/.test(form.version)
        ? "Version must look like 1.0.0"
        : listings.some((l) => l.card.id === form.id && l.card.version === form.version)
          ? `${form.id}@${form.version} is already listed: use a new version`
          : !form.name.trim()
            ? "Give your model a name"
            : null;
  const valid = missing === null;

  if (key) return <Progress snap={snap} state={state} error={error} onAgain={() => (setKey(null), setState(null), history.replaceState(null, "", "#/publish"))} />;

  const [ns, shortName] = form.id.includes("/") ? form.id.split("/") : ["", form.id];
  const initials = (form.name || shortName || "M").replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "M";

  return (
    <div className="page pg">
      <h1 className="sr-only">New model</h1>

      {error && <div className="banner">{error}</div>}
      {templates && templates.length === 0 && (
        <div className="banner">
          Browser publishing is off on this node. Use the CLI: <code>npm run kinetic -- models publish --card card.json</code>
        </div>
      )}

      <section className="pub-sec pub-task" aria-label="Task">
        <header>
          <h2>Task</h2>
          <p>Verifiers benchmark your model on labelled data you never see.</p>
        </header>
        <div className="templates" role="radiogroup" aria-label="Task template">
          {(templates ?? []).map((t) => (
            <button key={t.id} role="radio" aria-checked={pick === t.id} className={`template ${pick === t.id ? "on" : ""}`} onClick={() => choose(t)}>
              <span className="kind">{KIND[t.task.kind]}</span>
              <b>{TEMPLATE_NAMES[t.id] ?? t.id}</b>
              <span className="labels">{names(t.task).slice(0, 5).join(" · ")}</span>
            </button>
          ))}
          {!templates && !error && [0, 1, 2, 3].map((i) => <div key={i} className="template skeleton" style={{ height: 92 }} />)}
          {templates && templates.length === 0 && <span className="muted small">No task templates on this node.</span>}
        </div>
      </section>

      <div className="pub">
        <div className="pub-form">
          <section className="fsec">
            <header>
              <h2>Identity</h2>
              <p>Listed versions are immutable. Publish updates as a new version.</p>
            </header>
            <div className="form-grid">
              <label>
                <span>Model id</span>
                <input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase().replace(/\s+/g, "-") })} placeholder="namespace/model-name" spellCheck={false} />
              </label>
              <label>
                <span>Version</span>
                <input value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} placeholder="1.0.0" spellCheck={false} />
              </label>
            </div>
          </section>

          <section className="fsec">
            <header>
              <h2>Listing</h2>
              <p>What buyers see in the model hub and the console.</p>
            </header>
            <div className="form-grid">
              <label className="full">
                <span>Display name</span>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Support Ticket Classifier" />
              </label>
              <label className="full">
                <span>Description</span>
                <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What it does, what it returns, and where it works best." />
              </label>
            </div>
          </section>

          <section className="fsec">
            <header>
              <h2>Licensing and royalty</h2>
              <p>Your share of each accepted chunk. Refunded work earns nothing.</p>
            </header>
            <div className="form-grid">
              <label>
                <span>Licence</span>
                <select value={form.license} onChange={(e) => setForm({ ...form, license: e.target.value })}>
                  <option>apache-2.0</option>
                  <option>mit</option>
                  <option>cc-by-4.0</option>
                  <option>llama3.1</option>
                </select>
              </label>
              <label>
                <span>Runtime</span>
                <input value="0G Compute · TeeML" disabled />
              </label>
              <label className="full">
                <span className="pub-royalty">
                  Royalty <b>{form.royalty}%</b>
                </span>
                <input type="range" min={0} max={30} step={0.5} value={form.royalty} onChange={(e) => setForm({ ...form, royalty: Number(e.target.value) })} aria-label="Royalty percentage" />
              </label>
            </div>
          </section>
        </div>

        <aside className="pub-side">
          <div className="pub-preview" aria-label="Listing preview">
            <div className="pub-preview-top">
              <span className="pub-preview-label">Preview</span>
              <span className="pub-pending">Pending review</span>
            </div>
            <div className="mtile-head">
              <span className="avatar lg pub-avatar" aria-hidden>
                {initials}
              </span>
              <div className="mtile-id">
                <span className="pub-preview-id">
                  {ns && <span className="ns">{ns}/</span>}
                  {shortName || "model-name"}
                </span>
                <span>
                  {template ? KIND[template.task.kind] : "No task chosen"} · v{form.version || "1.0.0"}
                </span>
              </div>
            </div>
            <p className="mtile-desc">{form.description || "Your description appears here."}</p>
            <div className="mtile-tags">
              <span className="chip">
                <Cloud size={12} strokeWidth={1.75} aria-hidden /> 0G Compute
              </span>
              <span className="chip">
                <Scale size={12} strokeWidth={1.75} aria-hidden /> {form.license}
              </span>
              <span className="chip">{form.royalty}% royalty</span>
            </div>
          </div>
        </aside>
      </div>

      <section className="pub-sec pub-review" aria-label="Review and publish">
        <header>
          <h2>Review and publish</h2>
          <p>What happens after you press Publish.</p>
        </header>
        <ol className="pub-steps">
          <li>
            <CloudUpload size={14} strokeWidth={1.75} aria-hidden /> Card signed, 0.01 ℏ listing fee paid over x402
          </li>
          <li>
            <BrainCircuit size={14} strokeWidth={1.75} aria-hidden /> Lead verifier benchmarks on hidden examples (70% to list)
          </li>
          <li>
            <Check size={14} strokeWidth={1.75} aria-hidden /> Two more verifiers re-run it and co-sign
          </li>
          <li>
            <Check size={14} strokeWidth={1.75} aria-hidden /> Passport to 0G Storage, receipt to Hedera, listing to Arkiv
          </li>
        </ol>
        <div className="pub-action">
          <div className="pub-as">
            <span className="muted small">Publishing as</span>
            <span className="mono small">{creator ? short(creator, 6) : "—"}</span>
          </div>
          <button className="btn primary pub-submit" disabled={!valid || busy} onClick={submit}>
            {busy ? "Starting…" : "Publish model"}
          </button>
          <p className={`small ${missing ? "warn" : "muted"}`}>{missing ?? "Usually under a minute"}</p>
        </div>
      </section>
    </div>
  );
}

function Progress({ snap, state, error, onAgain }: { snap: Snapshot; state: PublishState | null; error: string | null; onAgain: () => void }) {
  const { status } = snap;
  const steps = state?.review?.steps ?? [];
  const lead = steps.find((s) => s.step === "lead");
  const cos = steps.filter((s) => s.step === "cosigner");
  const passport = steps.find((s) => s.step === "passport");
  const hcs = steps.find((s) => s.step === "hcs");
  const arkiv = steps.find((s) => s.step === "arkiv");
  const expected = Math.max(1, (status.quorum?.verifiers.length ?? 3) - 1);
  const elapsed = state ? Math.round(((state.finishedAt ?? Date.now()) - state.startedAt) / 1000) : 0;
  const listed = state?.status === "listed";
  const failed = state?.status === "refused" || state?.status === "failed";

  type S = "done" | "active" | "todo" | "bad";
  const at = (t?: number) => (t && state ? `${Math.max(0, Math.round((t - state.startedAt) / 1000))}s` : "");
  const feeLink = state?.feeTx ? hashscan(status, "transaction", state.feeTx) : null;
  const rows: { label: string; detail?: ReactNode; s: S; when?: string }[] = [
    { label: "Card signed by the creator", detail: state ? <span className="mono">{short(state.creator, 6)}</span> : undefined, s: state ? "done" : "active", when: state ? "0s" : "" },
    {
      label: "Listing fee paid over x402",
      detail: state?.feeTx ? feeLink ? <a className="ext mono" href={feeLink} target="_blank" rel="noreferrer">0.01 ℏ · {short(state.feeTx, 8)}</a> : <span className="mono">{state.feeTx}</span> : "0.01 ℏ to the verifier",
      s: state?.feeTx ? "done" : failed ? "bad" : "active",
    },
    {
      label: "Lead verifier: checks and benchmark",
      detail: lead ? lead.detail : state?.feeTx ? "running the model on hidden labelled examples…" : undefined,
      s: lead ? (lead.ok ? "done" : "bad") : state?.feeTx ? (failed ? "bad" : "active") : "todo",
      when: at(lead?.at),
    },
    ...Array.from({ length: expected }, (_, i) => {
      const c = cos[i];
      return {
        label: `Verifier ${i + 2} re-runs the review`,
        detail: c ? (c.ok ? <>signed · <span className="mono">{short(c.by ?? "", 4)}</span></> : c.detail) : lead?.ok ? "downloading, checking and benchmarking on its own…" : undefined,
        s: (c ? (c.ok ? "done" : "bad") : lead?.ok ? (failed ? "bad" : "active") : "todo") as S,
        when: at(c?.at),
      };
    }),
    {
      label: "Model Passport stored on 0G Storage",
      detail: passport ? (
        storageLink(status, passport.ref) ? <a className="ext mono" href={storageLink(status, passport.ref)!} target="_blank" rel="noreferrer">{short(passport.ref ?? "", 8)}</a> : <span className="mono">{short(passport.ref ?? "", 8)}</span>
      ) : undefined,
      s: passport ? "done" : cos.length >= expected && !failed ? "active" : "todo",
      when: at(passport?.at),
    },
    {
      label: "Receipt on Hedera HCS",
      detail: hcs ? (hashscan(status, "topic", status.hcsTopic) ? <a className="ext mono" href={hashscan(status, "topic", status.hcsTopic)!} target="_blank" rel="noreferrer">{status.hcsTopic} · #{hcs.ref}</a> : `#${hcs.ref}`) : undefined,
      s: hcs ? "done" : passport ? "active" : "todo",
      when: at(hcs?.at),
    },
    { label: "Listed on Arkiv", detail: arkiv ? <span className="mono">{short(arkiv.ref ?? "", 8)}</span> : undefined, s: arkiv ? "done" : hcs ? "active" : "todo", when: at(arkiv?.at) },
  ];

  return (
    <div className="page pg">
      <div className="pg-head">
        <div>
          <h1>{listed ? "Your model is live" : failed ? "Not listed" : "Publishing…"}</h1>
          <p className="muted">
            <span className="mono">
              {state?.id ?? "…"}@{state?.version ?? ""}
            </span>{" "}
            · {elapsed}s
          </p>
        </div>
        {(listed || failed) && (
          <button className="btn" onClick={onAgain}>
            Publish another
          </button>
        )}
      </div>
      {error && <div className="banner">{error}</div>}

      <div className="mlayout">
        <div className="panel" style={{ padding: "8px 20px" }}>
          <ol className="stepper big">
            {rows.map((r) => (
              <li key={r.label} className={r.s}>
                <span className="dot" aria-hidden>
                  {r.s === "done" ? "✓" : r.s === "bad" ? "!" : ""}
                </span>
                <span>
                  <b>{r.label}</b>
                  {r.detail && <span className="d">{r.detail}</span>}
                </span>
                <span className="when">{r.when}</span>
              </li>
            ))}
          </ol>
          {failed && (
            <div className="banner" style={{ margin: "8px 0 14px" }}>
              {state?.review?.reasons?.join("; ") ?? state?.error}
            </div>
          )}
        </div>
        <aside className="side">
          {listed && state ? (
            <div className="side-card success">
              <div className="big-check" aria-hidden>
                ✓
              </div>
              <h4>Verified by {state.result?.signers.length ?? 3} verifiers</h4>
              <p className="small muted">Benchmark {Math.round((state.result?.accuracy ?? 0) * 100)}% on hidden examples. Anyone can re-check the passport.</p>
              <a className="btn primary" href={`#/models/${state.key}`} style={{ marginTop: 12 }}>
                View model & try it
              </a>
            </div>
          ) : (
            <div className="side-card">
              <h4>Why three verifiers?</h4>
              <p className="small muted">Each runs its own checks and benchmark, and signs only if the results match. No single verifier can list a model.</p>
            </div>
          )}
          <div className="side-card">
            <h4>Activity</h4>
            <ul className="activity">
              {(state?.events ?? []).slice(-6).map((e) => (
                <li key={e.at + e.message}>
                  <span className="when">{Math.max(0, Math.round((e.at - (state?.startedAt ?? e.at)) / 1000))}s</span>
                  <span title={e.message}>{e.message}</span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
