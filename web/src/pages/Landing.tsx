// Landing page. Its structure follows the Akash Network website's homepage (MIT, github.com/akash-network/website):
// headline, "Built on" strip, auto-advancing showcase, numbered "How it works" stepper beside a
// live window, card grid, closing band and column footer. Content, brand and visuals are KINETIC's own.
// The problem-first section and the walkthrough beside the live network ring take their idea (not their
// look) from the GPU Pool pitch: say what's broken first, then step through how the network fixes it.
import { useEffect, useRef, useState, type ComponentType } from "react";
import {
  ArrowRight,
  BrainCircuit,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Database,
  Gauge,
  MonitorCheck,
  Network,
  Pause,
  Play,
  ShieldX,
  type LucideProps,
} from "lucide-react";
import { REPLAY } from "../data";
import { HexField } from "../hexfield";
import { NetworkRing } from "../netring";
import { go } from "../live";
import { Tag } from "../ui";

type Icon = ComponentType<LucideProps>;

const REDUCED = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const STACK: [string, string][] = [
  ["Hedera", "Payments"],
  ["0G", "Compute · Storage"],
  ["Arkiv", "State"],
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

/** The six stages every job goes through. `look` says what the ring highlights for each. */
const STAGES: { title: string; text: string; look: string }[] = [
  { title: "Qualify", text: "A new GPU answers known-answer probes before it's paid for anything. A GPU that fails is never paid.", look: "Rejected GPUs are marked in amber. They never get paid work." },
  { title: "Split", text: "Each job is cut into small chunks, each paid for separately over x402, so you never have more than a few chunks at risk.", look: "Chunks travel from live GPUs to the verifier." },
  { title: "Verify", text: "Hidden known answers and 0G TeeML canaries are mixed into real work. A GPU can't tell a check from a paid chunk.", look: "Every result passes through the verifier." },
  { title: "Enforce", text: "A GPU that fails too many checks is slashed by a verifier quorum. You're refunded from its bond.", look: "Slashed GPUs turn red." },
  { title: "Recover", text: "Chunks from cheating or offline GPUs move to honest ones automatically, so the job still finishes.", look: "Offline and slashed links go dark; live ones carry the work." },
  { title: "Prove", text: "Every payment, check and slash is a receipt on Hedera HCS, and the job ends with a signed Compute Passport.", look: "Receipts land on the HCS topic." },
];

/** How cheap compute cheats. These are the three ways KINETIC's own adversarial test GPUs cheat on the live testnet. */
const CHEATS: { at: number; what: string }[] = [
  { at: 2, what: "never runs the model" },
  { at: 6, what: "stops after a few chunks" },
  { at: 9, what: "takes the payment, goes offline" },
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

      <section className="ak-band" aria-labelledby="pb-h">
        <div className="ak-wrap">
          <Problem />
        </div>
      </section>

      <section className="ak-band" aria-labelledby="ak-about-h">
        <div className="ak-wrap">
          <Showcase />
        </div>
      </section>

      <section className="ak-band" aria-labelledby="wt-h">
        <div className="ak-wrap">
          <Walkthrough />
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

/* ───────── The problem, first ───────── */

function Problem() {
  return (
    <div className="pb">
      <header className="ak-head">
        <span className="pb-kicker">The problem</span>
        <h2 id="pb-h">Community GPUs are cheap. You can't see what they ran.</h2>
        <p>Paying strangers for compute means trusting them to run the model you asked for, every time.</p>
      </header>
      <div className="pb-stage">
        <ul className="pb-grid" aria-label="Twelve community GPUs, three of them cheating">
          {Array.from({ length: 12 }, (_, i) => {
            const cheat = CHEATS.find((c) => c.at === i);
            return (
              <li key={i} className={cheat ? "cheat" : ""}>
                <Cpu size={22} strokeWidth={1.5} aria-hidden />
                <span className="pb-gpu">gpu-{String(i + 1).padStart(2, "0")}</span>
                {cheat && <span className="pb-why">{cheat.what}</span>}
              </li>
            );
          })}
        </ul>
        <div className="pb-note">
          <svg viewBox="0 0 160 90" className="pb-arrow" aria-hidden>
            <path d="M 150 10 C 110 6, 60 20, 18 72" />
            <path d="M 14 56 L 18 74 L 34 66" />
          </svg>
          <p>
            <b>KINETIC checks every one.</b> If a GPU cheats, it's slashed and you're refunded from its bond.
          </p>
        </div>
      </div>
      <p className="pb-foot">Illustration. The three cheats shown are the ones KINETIC's own adversarial test GPUs commit on the live testnet, where they get caught.</p>
    </div>
  );
}

/* ───────── Walkthrough: the six trust stages beside the live network ───────── */

function Walkthrough() {
  const a = useAutoplay(STAGES.length, 6500);
  const s = STAGES[a.cur];
  const n = (i: number) => String(i + 1).padStart(2, "0");
  return (
    <div className="ak-split wt" ref={a.ref}>
      <div className="ak-split-text">
        <header className="ak-head">
          <h2 id="wt-h">How every job is checked</h2>
          <p>Six stages, on the live network. The ring shows the real GPUs on Hedera testnet right now.</p>
        </header>
        <div className="wt-card" aria-live="polite">
          <div className="wt-count">
            <b>{n(a.cur)}</b> / {n(STAGES.length - 1)}
          </div>
          <h3>{s.title}</h3>
          <p>{s.text}</p>
          <p className="wt-look">{s.look}</p>
          <div className="wt-nav">
            <button className="wt-btn" onClick={() => a.goTo((a.cur - 1 + STAGES.length) % STAGES.length)} aria-label="Previous stage">
              <ChevronLeft size={16} aria-hidden />
            </button>
            <button className="wt-btn" onClick={() => a.goTo((a.cur + 1) % STAGES.length)} aria-label="Next stage">
              <ChevronRight size={16} aria-hidden />
            </button>
          </div>
        </div>
        <div className="ak-progress-row">
          <Progress count={STAGES.length} label="Show stage" cur={a.cur} fill={a.fill} playing={a.playing} goTo={a.goTo} toggle={a.toggle} />
          <a className="ak-cta-sm" href="#/console">
            Open the console <ChevronRight size={12} aria-hidden />
          </a>
        </div>
      </div>
      <NetworkRing stage={a.cur} />
    </div>
  );
}
