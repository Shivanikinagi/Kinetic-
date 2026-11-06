import { useEffect, useState, type ReactNode } from "react";
import { Menu, X } from "lucide-react";
import { CONSOLE_SECTIONS, Console, Explorer } from "./console";
import { REPLAY, setReplay } from "./data";
import { LiveProvider, useLive, useRoute, type Snapshot } from "./live";
import Audit from "./pages/Audit";
import Creators from "./pages/Creators";
import Docs from "./pages/Docs";
import Publish from "./pages/Publish";
import RentGpu from "./pages/RentGpu";
import { JobDetail, JobList } from "./pages/Jobs";
import { ModelDetail, ModelList } from "./pages/Models";
import Landing from "./pages/Landing";
import Overview from "./pages/Overview";
import Providers from "./pages/Providers";
import Run from "./pages/Run";
import { SiteFooter } from "./sitefooter";
import { ZeroGAccount, ZeroGProvider } from "./zerog";

// The header's two toggles. Everything you operate (runs, jobs, GPUs, publishing, creators, docs) lives under Console.
const NAV: [string, string][] = [
  ["models", "Models"],
  ["console", "Console"],
];

export default function App() {
  return (
    <ZeroGProvider>
      <LiveProvider>
        <Shell />
      </LiveProvider>
    </ZeroGProvider>
  );
}

function Shell() {
  const route = useRoute();
  const { snap, error } = useLive();
  const section = route[0] ?? "";
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [route.join("/")]);
  // The small-screen menu drops below the floating header; Escape closes it.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);
  const inConsole = CONSOLE_SECTIONS.has(section);
  const active = inConsole ? "console" : section;
  const landing = !inConsole && section !== "models";
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (!landing) return;
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, [landing]);

  // The console is its own full-screen workspace: no website header, footer or status bar.
  if (inConsole) {
    return (
      <>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <Console route={route} snap={snap} error={error}>
          <ConsolePage route={route} snap={snap} />
        </Console>
      </>
    );
  }

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className={`topbar ${landing ? `is-landing ${scrolled ? "scrolled" : ""}` : ""}`}>
        <a className="brand" href="#/" aria-label="KINETIC home">
          <span className="brand-mark" aria-hidden />
          <span className="brand-word">KINETIC</span>
        </a>
        <button className="menu-btn" aria-expanded={menu} aria-controls="primary-nav" onClick={() => setMenu(!menu)}>
          <span className="sr-only">Menu</span>
          {menu ? <X size={18} strokeWidth={1.75} aria-hidden /> : <Menu size={18} strokeWidth={1.75} aria-hidden />}
        </button>
        <nav id="primary-nav" className={`nav ${menu ? "open" : ""}`} aria-label="Sections">
          {NAV.map(([path, text]) => (
            <a key={path} href={`#/${path}`} aria-current={active === path ? "page" : undefined}>
              {text}
            </a>
          ))}
        </nav>
        <div className="topbar-right">
          {REPLAY && (
            <button className="replay-badge" title="Synthetic data. No network calls or real transactions. Click to return to live." onClick={() => setReplay(false)}>
              synthetic replay · exit
            </button>
          )}
          {error && snap && (
            <span className="net-note" title={error}>
              Some data is delayed
            </span>
          )}
          {snap && !REPLAY && (
            <span className="live-dot" title={`Live on ${snap.status.network}`}>
              <span aria-hidden />
              {snap.status.network}
            </span>
          )}
          <ZeroGAccount />
        </div>
      </header>

      {error && !snap && !landing && (
        <div className="banner-wrap">
          <div className="banner" role="status">
            {`Waiting for the verifier: ${error}`}
            {!snap && !REPLAY && (
              <>
                {" "}
                <button className="link" onClick={() => setReplay(true)}>
                  Use the synthetic replay instead →
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <main id="main">
        {landing ? (
          <Landing />
        ) : !snap ? (
          <Loading />
        ) : route[1] === "search" ? (
          <ModelList key={route[2]} snap={snap} query={decodeURIComponent(route[2] ?? "")} />
        ) : route[1] ? (
          <ModelDetail snap={snap} modelKey={route[1]} />
        ) : (
          <ModelList snap={snap} />
        )}
      </main>

      <SiteFooter snap={snap} />
    </>
  );
}

function ConsolePage({ route, snap }: { route: string[]; snap: Snapshot | null }): ReactNode {
  const [section, sub] = route;
  if (section === "docs") return <Docs />;
  if (!snap) return <Loading />;
  if (section === "providers") return <Providers snap={snap} />;
  if (section === "jobs") return sub ? <JobDetail snap={snap} jobId={sub} /> : <JobList snap={snap} />;
  if (section === "run") return <Run snap={snap} modelKey={sub} />;
  if (section === "publish") return <Publish key={sub ?? "new"} snap={snap} {...(sub ? { resume: sub } : {})} />;
  if (section === "creators") return <Creators snap={snap} {...(sub ? { creator: sub } : {})} />;
  if (section === "explorer") return <Explorer snap={snap} path={route.join("/")} />;
  if (section === "audit") return <Audit snap={snap} />;
  // The old Earn page is gone: its provider half is #/provide, its publisher half is #/publish.
  if (section === "provide" || (section === "earn" && sub === "provide")) return <RentGpu snap={snap} />;
  if (section === "earn") return <Publish snap={snap} />;
  return <Overview snap={snap} />;
}

function Loading() {
  return (
    <div className="page pg" aria-busy="true">
      <section className="kpis">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="kpi">
            <div className="skeleton" style={{ width: 60, height: 28 }} />
            <div className="skeleton" style={{ width: 80, height: 10 }} />
          </div>
        ))}
      </section>
      <p className="small muted" style={{ marginTop: 24 }}>
        Connecting to the network. Start it with <code>npm run live -- --serve</code>.
      </p>
    </div>
  );
}
