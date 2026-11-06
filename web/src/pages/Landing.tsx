// Landing page. Its structure follows the Akash Network website's homepage (MIT, github.com/akash-network/website):
// headline, "Built on" strip, auto-advancing showcase, numbered "How it works" stepper beside a
// live window, card grid, closing band and column footer. Content, brand and visuals are KINETIC's own.
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  ArrowRight,
  BrainCircuit,
  Check,
  ChevronRight,
  Database,
  Gauge,
  MonitorCheck,
  Network,
  Pause,
  Play,
  ShieldX,
  X,
  type LucideProps,
} from "lucide-react";
import { REPLAY } from "../data";
import { HexField } from "../hexfield";
import { go } from "../live";
import { Tag } from "../ui";

type Icon = ComponentType<LucideProps>;

const REDUCED = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const STACK: [string, string][] = [
  ["Hedera", "Payments"],
  ["0G", "Compute"],
  ["Arkiv", "State"],
  ["Swarm", "Storage"],
];

const ROLES: { title: string; text: string; href: string; cta: string; shot: string; alt: string }[] = [
  {
    title: "Run AI jobs",
    text: "Batch classification, extraction and tagging. Pay only for chunks that pass.",
    href: "#/run",
    cta: "Run a job",
    shot: "./shots/run.webp",
    alt: "The Run page in the KINETIC console",
  },
  {
    title: "Rent out a GPU",
    text: "Bond HBAR, serve verified models, earn per honest chunk.",
    href: "#/provide",
    cta: "Start providing",
    shot: "./shots/gpus.webp",
    alt: "Available GPUs in the KINETIC console",
  },
  {
    title: "Publish a model",
    text: "List with a signed Model Passport. Earn a royalty on every job.",
    href: "#/publish",
    cta: "Publish a model",
    shot: "./shots/publish.webp",
    alt: "The Publish page in the KINETIC console",
  },
];

const STEPS: [string, string][] = [
  ["Publish", "Verifiers scan, benchmark and sign every model."],
  ["Run", "Jobs split into chunks across community GPUs. Pay per chunk in HBAR."],
  ["Check", "Hidden known answers and 0G canaries test every GPU."],
  ["Refund", "Cheating GPUs are slashed. You're refunded from their bond."],
];

const CAPABILITIES: [Icon, string, string][] = [
  [MonitorCheck, "Evaluate before work", "GPUs pass known-answer probes before any work."],
  [Gauge, "Monitor during work", "Every chunk is format-checked and spot-checked on 0G."],
  [Network, "Reroute", "Work from offline or failing GPUs moves automatically."],
  [ShieldX, "Enforce", "Failing GPUs are slashed by a verifier quorum."],
  [Database, "Audit trail", "Every payment, check and slash is recorded on Hedera."],
  [BrainCircuit, "Model Passport", "Every model is scanned, benchmarked and signed."],
];

export default function Landing() {
  const [q, setQ] = useState("");
  return (
    <div className="landing ak">
      <HexField className="lp-hexfield">
        <section className="ak-hero">
          {REPLAY && <Tag tone="warn">Synthetic replay: no network calls</Tag>}
          <span className="ak-badge">
            <span aria-hidden /> Verifiable AI hub
          </span>
          <Headline lines={["Verified AI models,", "run on community GPUs"]} />
          <p className="ak-hero-sub">Every result is checked. If a GPU cheats, you're refunded from its bond.</p>
          <form
            className="ak-try"
            onSubmit={(e) => {
              e.preventDefault();
              go(q.trim() ? `models/search/${encodeURIComponent(q.trim())}` : "models");
            }}
          >
            <input type="search" placeholder="Search models, e.g. ticket classifier" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search models" />
            <button className="btn primary" type="submit">
              Browse models
            </button>
          </form>
        </section>
      </HexField>

      <section className="ak-builton" aria-label="Built on">
        <span className="ak-builton-label">Built on</span>
        <ul>
          {STACK.map(([name, role]) => (
            <li key={name}>
              <b>{name}</b>
              <span>{role}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="ak-band" aria-labelledby="ak-about-h">
        <div className="ak-wrap">
          <Showcase />
        </div>
      </section>

      <section className="ak-band" aria-labelledby="ak-how-h">
        <div className="ak-wrap">
          <HowItWorks />
        </div>
      </section>

      <section className="ak-band" aria-labelledby="ak-cap-h">
        <div className="ak-wrap">
          <header className="ak-head">
            <h2 id="ak-cap-h">What every job gets</h2>
            <p>Checks run before, during and after every job.</p>
          </header>
          <ul className="ak-cards">
            {CAPABILITIES.map(([Icon, title, text]) => (
              <li key={title}>
                <span className="ak-card-icon" aria-hidden>
                  <Icon size={18} strokeWidth={1.75} />
                </span>
                <h3>{title}</h3>
                <p>{text}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="ak-cta" aria-labelledby="ak-cta-h">
        <h2 id="ak-cta-h">Run your first verified job</h2>
        <p>Pick a model, set a budget, pay only for verified chunks.</p>
        <div className="ak-cta-actions">
          <a className="btn primary lg" href="#/run">
            Run a job <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
          </a>
          <a className="btn lg" href="#/docs">
            Read the docs
          </a>
        </div>
      </section>

    </div>
  );
}

/* ───────── Headline ───────── */

/** The hero title: one line per entry, plain text. */
function Headline({ lines }: { lines: string[] }) {
  return (
    <h1 className="ak-headline">
      {lines.map((line) => (
        <span key={line} className="ak-hl-line">
          {line}
        </span>
      ))}
    </h1>
  );
}

/* ───────── Auto-advancing slides ───────── */

/** Advances through `count` slides every `dur` ms while playing and on screen; `fill` is the current slide's progress (0–1). */
function useAutoplay(count: number, dur: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [cur, setCur] = useState(0);
  const [playing, setPlaying] = useState(!REDUCED);
  const [visible, setVisible] = useState(false);
  const [fill, setFill] = useState(0);
  const fillRef = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!playing || !visible) return;
    let raf = 0;
    const t0 = performance.now() - fillRef.current * dur;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      if (p >= 1) {
        fillRef.current = 0;
        setFill(0);
        setCur((c) => (c + 1) % count);
        return;
      }
      fillRef.current = p;
      setFill(p);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, visible, cur, count, dur]);

  const goTo = (i: number) => {
    fillRef.current = 0;
    setFill(0);
    setCur(i);
  };
  return { ref, cur, fill, playing, goTo, toggle: () => setPlaying(!playing) };
}

function Progress({ count, cur, fill, playing, goTo, toggle, label }: { count: number; cur: number; fill: number; playing: boolean; goTo: (i: number) => void; toggle: () => void; label: string }) {
  return (
    <div className="ak-progress">
      <div className="ak-progress-dots">
        {Array.from({ length: count }, (_, i) => (
          <button key={i} className={i === cur ? "on" : ""} onClick={() => goTo(i)} aria-label={`${label} ${i + 1}`} aria-current={i === cur ? "step" : undefined}>
            {i === cur && <span style={{ width: `${(playing ? fill : 1) * 100}%` }} />}
          </button>
        ))}
      </div>
      <button className="ak-progress-play" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
        {playing ? <Pause size={12} aria-hidden /> : <Play size={12} aria-hidden />}
      </button>
    </div>
  );
}

/* ───────── What KINETIC is: three roles beside console screenshots ───────── */

function Showcase() {
  const a = useAutoplay(ROLES.length, 5000);
  return (
    <div className="ak-split" ref={a.ref}>
      <div className="ak-split-text">
        <header className="ak-head">
          <h2 id="ak-about-h">What KINETIC is</h2>
          <p>Verified AI on community GPUs. Every result is checked before anyone is paid.</p>
        </header>
        <ul className="ak-rows">
          {ROLES.map((r, i) => (
            <li key={r.title} className={i === a.cur ? "on" : ""}>
              <button className="ak-row-head" onClick={() => a.goTo(i)} aria-expanded={i === a.cur}>
                <span className="ak-row-dot" aria-hidden />
                {r.title}
              </button>
              {i === a.cur && (
                <div className="ak-row-body">
                  <p>{r.text}</p>
                  <a className="ak-cta-sm" href={r.href}>
                    {r.cta} <ChevronRight size={12} aria-hidden />
                  </a>
                </div>
              )}
            </li>
          ))}
        </ul>
        <Progress count={ROLES.length} label="Show role" cur={a.cur} fill={a.fill} playing={a.playing} goTo={a.goTo} toggle={a.toggle} />
      </div>
      <div className="ak-shot">
        {ROLES.map((r, i) => (
          <img key={r.shot} src={r.shot} alt={i === a.cur ? r.alt : ""} aria-hidden={i !== a.cur} className={i === a.cur ? "on" : ""} />
        ))}
      </div>
    </div>
  );
}

/* ───────── How it works: numbered steps beside a live window ───────── */

function HowItWorks() {
  const a = useAutoplay(STEPS.length, 6000);
  const frames = [<PublishFrame />, <RunFrame />, <CheckFrame />, <RefundFrame />];
  return (
    <div className="ak-split flip" ref={a.ref}>
      <div className="ak-split-text">
        <header className="ak-head">
          <h2 id="ak-how-h">How it works</h2>
          <p>From model to verified result in four steps.</p>
        </header>
        <ol className="ak-steps">
          {STEPS.map(([title, text], i) => (
            <li key={title} className={i === a.cur ? "on" : ""}>
              <button className="ak-step-head" onClick={() => a.goTo(i)} aria-expanded={i === a.cur}>
                <span className="ak-step-n" aria-hidden>
                  {i + 1}
                </span>
                {title}
              </button>
              {i === a.cur && <p>{text}</p>}
            </li>
          ))}
        </ol>
        <div className="ak-progress-row">
          <Progress count={STEPS.length} label="Show step" cur={a.cur} fill={a.fill} playing={a.playing} goTo={a.goTo} toggle={a.toggle} />
          <a className="ak-cta-sm" href="#/console">
            Open the console <ChevronRight size={12} aria-hidden />
          </a>
        </div>
      </div>
      <Window key={a.cur} title={STEPS[a.cur][0]}>
        {frames[a.cur]}
      </Window>
    </div>
  );
}

function Window({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="ak-window">
      <div className="ak-window-bar">
        <span aria-hidden />
        <span aria-hidden />
        <span aria-hidden />
        <b>{title}</b>
        <em>Example</em>
      </div>
      <div className="ak-window-body">{children}</div>
    </div>
  );
}

/** Reveals 0…n items one every `every` ms after mount (all at once with reduced motion). */
function useReveal(n: number, every: number, delay = 300) {
  const [shown, setShown] = useState(REDUCED ? n : 0);
  useEffect(() => {
    if (REDUCED) return;
    const ts = Array.from({ length: n }, (_, i) => window.setTimeout(() => setShown(i + 1), delay + i * every));
    return () => ts.forEach(window.clearTimeout);
  }, [n, every, delay]);
  return shown;
}

function Mark({ ok }: { ok: boolean }) {
  return <span className={`ak-mark ${ok ? "ok" : "bad"}`}>{ok ? <Check size={12} strokeWidth={2.5} aria-hidden /> : <X size={12} strokeWidth={2.5} aria-hidden />}</span>;
}

function PublishFrame() {
  const rows: [string, string][] = [
    ["Weights scan", "safetensors · clean"],
    ["Benchmark", "94.2% on hidden set"],
    ["verifier-1", "signed"],
    ["verifier-2", "signed"],
    ["verifier-3", "signed"],
  ];
  const shown = useReveal(rows.length, 550);
  return (
    <div className="ak-frame">
      <div className="ak-frame-card">
        <div className="ak-frame-title">
          <span>
            <b>ticket-classifier</b> v1
          </span>
          <span className={`ak-pill ${shown === rows.length ? "ok" : ""}`}>{shown === rows.length ? "Listed" : "In review"}</span>
        </div>
        <ul className="ak-frame-list">
          {rows.map(([k, v], i) => (
            <li key={k} className={i < shown ? "in" : ""}>
              <Mark ok />
              <span>{k}</span>
              <span className="mono">{v}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="ak-frame-note">Model Passport · 3 of 3 signatures</p>
    </div>
  );
}

function RunFrame() {
  const total = 48;
  const done = useReveal(total, 70, 200);
  return (
    <div className="ak-frame">
      <div className="ak-frame-card">
        <div className="ak-frame-title">
          <span>
            <b>Job 0x3f…a2</b> · ticket-classifier
          </span>
          <span className="ak-pill">{done === total ? "Done" : "Running"}</span>
        </div>
        <div className="ak-chunks" aria-hidden>
          {Array.from({ length: total }, (_, i) => (
            <span key={i} className={i < done ? "ok" : i < done + 4 ? "run" : ""} />
          ))}
        </div>
        <dl className="ak-frame-kv">
          <div>
            <dt>Chunks</dt>
            <dd className="mono">
              {done}/{total}
            </dd>
          </div>
          <div>
            <dt>GPUs</dt>
            <dd className="mono">4</dd>
          </div>
          <div>
            <dt>Spent</dt>
            <dd className="mono">{(done * 0.05).toFixed(2)} HBAR</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function CheckFrame() {
  const rows: [boolean, string, string][] = [
    [true, "Known-answer probe", "gpu-a"],
    [true, "Known-answer probe", "gpu-b"],
    [true, "0G canary · chunk 12", "gpu-a"],
    [true, "0G canary · chunk 19", "gpu-b"],
    [false, "0G canary · chunk 27", "gpu-c"],
  ];
  const shown = useReveal(rows.length, 600);
  return (
    <div className="ak-frame">
      <div className="ak-frame-card">
        <div className="ak-frame-title">
          <span>
            <b>Checks</b>
          </span>
          <span className={`ak-pill ${shown === rows.length ? "bad" : ""}`}>{shown === rows.length ? "1 failed" : "Checking"}</span>
        </div>
        <ul className="ak-frame-list">
          {rows.map(([ok, k, v], i) => (
            <li key={k + v} className={i < shown ? "in" : ""}>
              <Mark ok={ok} />
              <span>{k}</span>
              <span className="mono">{v}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function RefundFrame() {
  const rows: [string, string, "bad" | "ok" | ""][] = [
    ["gpu-c slashed", "−50 HBAR bond", "bad"],
    ["Chunks rerouted", "gpu-c → gpu-a", ""],
    ["Refund to you", "+1.35 HBAR", "ok"],
    ["Receipt", "Hedera HCS", ""],
  ];
  const shown = useReveal(rows.length, 650);
  return (
    <div className="ak-frame">
      <div className="ak-frame-card">
        <div className="ak-frame-title">
          <span>
            <b>Settlement</b>
          </span>
          <span className={`ak-pill ${shown === rows.length ? "ok" : ""}`}>{shown === rows.length ? "Settled" : "Settling"}</span>
        </div>
        <ul className="ak-frame-list">
          {rows.map(([k, v, tone], i) => (
            <li key={k} className={i < shown ? "in" : ""}>
              <span className={`ak-dot ${tone}`} aria-hidden />
              <span>{k}</span>
              <span className={`mono ${tone}`}>{v}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
