import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  ArrowLeft,
  Bell,
  BrainCircuit,
  CloudUpload,
  CodeXml,
  Cpu,
  Database,
  FileCode,
  Gauge,
  PanelLeft,
  Plus,
  Search,
  ShieldX,
  SquareTerminal,
  Wallet,
  Workflow,
  X,
  type LucideProps,
} from "lucide-react";
import { REPLAY, getAgentInfo, getHbarBalance, gpuState, hashscan, hbar, listingsOf, money, setReplay, short } from "./data";
import { go, useLive, type Snapshot } from "./live";
import { latestPerId } from "./pages/Models";
import { sortedJobs } from "./pages/Overview";
import { ReceiptText, Tag, receiptTag, receiptTone, timeOf } from "./ui";
import { ZeroGAccount } from "./zerog";

// The console: a full-screen workspace (title bar, activity bar, explorer, editor tabs, bottom
// panel, status bar), in the spirit of VS Code or Colab. Every route below opens inside it.
export const CONSOLE_SECTIONS = new Set(["console", "run", "jobs", "providers", "publish", "creators", "explorer", "audit", "docs", "earn", "provide"]);

type IconT = ComponentType<LucideProps>;
type Item = [key: string, href: string, text: string, Icon: IconT];

const ACTIVITY: Item[] = [
  ["console", "#/console", "Overview", Gauge],
  ["run", "#/run", "Run", SquareTerminal],
  ["jobs", "#/jobs", "Jobs", Workflow],
  ["providers", "#/providers", "GPUs", Cpu],
  ["publish", "#/publish", "Publish", CloudUpload],
  ["creators", "#/creators", "Creators", CodeXml],
  ["explorer", "#/explorer", "Explorer", PanelLeft],
  ["audit", "#/audit", "Audit trail", Database],
];
const ACTIVITY_BOTTOM: Item[] = [["docs", "#/docs", "Docs", FileCode]];
const ALL = [...ACTIVITY, ...ACTIVITY_BOTTOM];
// The side navigation, grouped the way you work: run things, ship things, check the record.
const NAV_GROUPS: [string, Item[]][] = [
  ["Workspace", ACTIVITY.slice(0, 4)],
  ["Build", ACTIVITY.slice(4, 6)],
  ["Records", ACTIVITY.slice(6)],
];

// Which activity a route belongs to. The old Earn routes still resolve: #/earn is Publish, #/earn/provide is GPUs.
export function consoleActive(section: string, sub?: string) {
  if (section === "provide" || (section === "earn" && sub === "provide")) return "providers";
  if (section === "earn") return "publish";
  return section;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl";

/** A tab title for a console route. */
function titleOf(path: string) {
  const [section, sub] = path.split("/");
  const item = ALL.find(([k]) => k === consoleActive(section, sub));
  if (section === "provide" || (section === "earn" && sub === "provide")) return { name: "Rent out a GPU", Icon: item?.[3] ?? Gauge };
  const name = item?.[2] ?? section;
  return { name: sub && section !== "earn" ? `${name} · ${short(decodeURIComponent(sub), 6)}` : name, Icon: item?.[3] ?? Gauge };
}

const dotOf = (status: string) => (["complete", "live", "admitted"].includes(status) ? "ok" : ["failed", "slashed", "rejected", "halted", "incomplete"].includes(status) ? "bad" : "run");

export function Console({ route, snap, error, children }: { route: string[]; snap: Snapshot | null; error: string | null; children: ReactNode }) {
  const path = route.join("/") || "console";
  const active = consoleActive(route[0], route[1]);
  // The Activity/Problems log drops down from the bell in the top-right corner; Ctrl/Cmd+J or the
  // status bar's problem count opens it too.
  const [panel, setPanel] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("activity");
  const [palette, setPalette] = useState(false);
  const [tabs, setTabs] = useState<string[]>([]);
  const content = useRef<HTMLDivElement>(null);

  // Each console route opens as a tab, like files in an editor.
  useEffect(() => {
    setTabs((t) => (t.includes(path) ? t : [...t, path].slice(-8)));
    content.current?.scrollTo(0, 0);
  }, [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "k" || (e.shiftKey && e.key.toLowerCase() === "p"))) {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (mod && e.key === "j") {
        e.preventDefault();
        setPanel((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const closeTab = (t: string) => {
    const rest = tabs.filter((x) => x !== t);
    setTabs(rest);
    if (t === path) go(rest[rest.length - 1] ?? "console");
  };

  const problems = snap ? problemsOf(snap) : [];
  const running = snap?.jobs.filter((j) => j.attrs.status === "running").length ?? 0;
  const live = snap?.offers.filter((o) => gpuState(snap, String(o.attrs.provider)) === "live").length ?? 0;

  return (
    <div className="ide">
      <header className="ide-title">
        <a className="ide-brand" href="#/" title="Back to the website">
          <span className="brand-mark" aria-hidden />
          <span>KINETIC</span>
          <span className="ide-brand-sub">Console</span>
        </a>
        <button className="ide-palette-btn" onClick={() => setPalette(true)} aria-haspopup="dialog">
          <Search size={14} strokeWidth={1.75} aria-hidden />
          <span>Search models, jobs, GPUs or go to…</span>
          <kbd>{MOD} K</kbd>
        </button>
        <div className="ide-title-right">
          {REPLAY && (
            <button className="replay-badge" title="Synthetic data. No network calls or real transactions. Click to return to live." onClick={() => setReplay(false)}>
              synthetic replay · exit
            </button>
          )}
          <BalancePill snap={snap} />
          <ZeroGAccount />
          <Panel snap={snap} problems={problems} open={panel} setOpen={setPanel} tab={panelTab} setTab={setPanelTab} />
        </div>
      </header>

      <nav className="ide-activity" aria-label="Console">
        {NAV_GROUPS.map(([group, items]) => (
          <div key={group} className="ide-act-group" role="group" aria-label={group}>
            <span className="ide-act-title" aria-hidden>
              {group}
            </span>
            {items.map((item) => (
              <ActivityLink key={item[0]} item={item} active={active} />
            ))}
          </div>
        ))}
        <span className="ide-activity-gap" />
        {ACTIVITY_BOTTOM.map((item) => (
          <ActivityLink key={item[0]} item={item} active={active} />
        ))}
      </nav>

      <section className="ide-editor">
        <div className="ide-tabs" role="tablist" aria-label="Open views">
          {tabs.map((t) => {
            const { name, Icon } = titleOf(t);
            const on = t === path;
            return (
              <div key={t} className={`ide-tab ${on ? "on" : ""}`}>
                <a href={`#/${t}`} role="tab" aria-selected={on}>
                  <Icon size={14} strokeWidth={1.75} aria-hidden />
                  {name}
                </a>
                <button onClick={() => closeTab(t)} aria-label={`Close ${name}`}>
                  <X size={12} strokeWidth={2} aria-hidden />
                </button>
              </div>
            );
          })}
          <span className="ide-tabs-fill" />
        </div>
        <div className="ide-content" id="main" ref={content} tabIndex={-1}>
          {error && !snap && (
            <div className="banner" role="status">
              {`Waiting for the verifier: ${error}`}
              {!REPLAY && (
                <>
                  {" "}
                  <button className="link" onClick={() => setReplay(true)}>
                    Use the synthetic replay instead →
                  </button>
                </>
              )}
            </div>
          )}
          {children}
        </div>
      </section>

      <footer className="ide-status">
        <span className="ide-status-net">
          <span className={`ide-dot ${snap ? "ok" : "run"}`} aria-hidden />
          {REPLAY ? "Synthetic replay" : snap ? `Hedera ${snap.status.network}` : "Connecting…"}
        </span>
        {snap && (
          <>
            <span>
              <Cpu size={12} strokeWidth={1.75} aria-hidden /> {live} GPUs live
            </span>
            <span className="ide-hide-sm">
              <Workflow size={12} strokeWidth={1.75} aria-hidden /> {running} running
            </span>
            <button
              className="ide-status-btn"
              onClick={() => {
                setPanelTab("problems");
                setPanel(true);
              }}
              title="Show failed checks and slashes"
            >
              <ShieldX size={12} strokeWidth={1.75} aria-hidden /> {problems.length} problems
            </button>
          </>
        )}
        <span className="ide-status-fill" />
        <DataSources snap={snap} />
        {snap && <span className="ide-hide-sm">Updated {new Date(snap.at).toLocaleTimeString()}</span>}
        <button className="ide-status-btn" onClick={() => setPalette(true)}>
          {MOD} K
        </button>
      </footer>

      {palette && <Palette snap={snap} onClose={() => setPalette(false)} />}
    </div>
  );
}

/**
 * The buyer agent's HBAR balance (the account that pays every job), read from the Hedera mirror
 * node every 30 s. Hidden in the replay and when the agent or the mirror node doesn't answer.
 */
function BalancePill({ snap }: { snap: Snapshot | null }) {
  const [account, setAccount] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  useEffect(() => {
    if (REPLAY) return;
    let alive = true;
    getAgentInfo()
      .then((i) => alive && setAccount(i.account ?? null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const status = snap?.status;
  useEffect(() => {
    if (!account || !status) return;
    let alive = true;
    const tick = () =>
      getHbarBalance(status, account)
        .then((b) => alive && setBalance(b))
        .catch(() => {});
    void tick();
    const t = window.setInterval(tick, 30_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [account, status?.mirrorUrl]);
  if (!account || balance === null || !status) return null;
  const href = hashscan(status, "account", account);
  const body = (
    <>
      <Wallet size={13} strokeWidth={1.75} aria-hidden />
      <span className="balance-v">{hbar(balance)}</span>
    </>
  );
  const title = `Buyer agent ${account}: pays every job. Read from the Hedera mirror node.`;
  return href ? (
    <a className="balance-pill" href={href} target="_blank" rel="noreferrer" title={title}>
      {body}
    </a>
  ) : (
    <span className="balance-pill" title={title}>
      {body}
    </span>
  );
}

/** Where every figure in the console comes from, each linked to its public source. */
function DataSources({ snap }: { snap: Snapshot | null }) {
  const status = snap?.status;
  const topic = status?.hcsTopic ? hashscan(status, "topic", status.hcsTopic) : null;
  const sources: [string, string, string | null | undefined][] = [
    ["Arkiv", "offers · jobs · chunks", status?.arkiv.explorerUrl],
    ["HCS", status?.hcsTopic ? `receipts ${status.hcsTopic}` : "receipts", topic],
    ["x402", "payments", null],
    ["0G Storage", "passports", status?.storageGateway],
  ];
  return (
    <span className="ide-sources ide-hide-sm" aria-label="Data sources">
      <span className="ide-sources-l">Data</span>
      {sources.map(([name, what, href]) => (
        <span key={name} className="ide-source">
          {href ? (
            <a href={href} target="_blank" rel="noreferrer">
              <b>{name}</b>
            </a>
          ) : (
            <b>{name}</b>
          )}{" "}
          {what}
        </span>
      ))}
    </span>
  );
}

function ActivityLink({ item: [key, href, text, Icon], active }: { item: Item; active: string }) {
  const on = active === key;
  return (
    <a href={href} aria-current={on ? "page" : undefined} aria-label={text} title={text}>
      <Icon size={18} strokeWidth={1.75} aria-hidden />
      <span className="ide-act-label">{text}</span>
    </a>
  );
}

/** The Explorer tab: the whole workspace as a tree of jobs, GPUs, models and creators. */
export function Explorer({ snap, path }: { snap: Snapshot | null; path: string }) {
  const { label } = useLive();
  const data = useMemo(() => {
    if (!snap) return null;
    const models = latestPerId(listingsOf(snap.status, snap.models));
    return {
      jobs: sortedJobs(snap).slice(0, 12),
      models,
      creators: [...new Set(models.map((m) => m.card.creator.address))],
    };
  }, [snap]);
  if (!snap || !data) return <div className="page pg ide-side-empty">Connecting to the network…</div>;
  const here = (href: string) => (`#/${path}` === href ? "page" : undefined);

  return (
    <div className="page pg ex">
      <div className="phead pg-bar">
        <h1 className="sr-only">Explorer</h1>
        <span className="small muted">
          {snap.jobs.length} jobs · {snap.offers.length} GPUs · {data.models.length} models · {data.creators.length} creators
        </span>
      </div>
      <Group title="Jobs" count={snap.jobs.length} action={["#/run", "New run"]}>
        {data.jobs.length === 0 && <span className="ide-none">No jobs yet</span>}
        {data.jobs.map((j) => {
          const id = String(j.attrs.job_id);
          const href = `#/jobs/${encodeURIComponent(id)}`;
          return (
            <a key={j.key} href={href} aria-current={here(href)}>
              <span className={`ide-dot ${dotOf(String(j.attrs.status))}`} aria-hidden />
              <span className="ide-name mono">{short(id, 8)}</span>
              <span className="ide-meta">
                {Number(j.attrs.done)}/{Number(j.attrs.total)}
              </span>
            </a>
          );
        })}
      </Group>
      <Group title="GPUs" count={snap.offers.length} action={["#/provide", "Rent out a GPU"]}>
        {snap.offers.length === 0 && <span className="ide-none">No GPUs online</span>}
        {snap.offers.map((o) => (
          <a key={o.key} href="#/providers" title={gpuState(snap, String(o.attrs.provider))}>
            <span className={`ide-dot ${dotOf(gpuState(snap, String(o.attrs.provider)))}`} aria-hidden />
            <span className="ide-name">{label(String(o.attrs.provider))}</span>
            <span className="ide-meta">{o.attrs.price === undefined ? "" : money(snap.status, o.attrs.price as number)}</span>
          </a>
        ))}
      </Group>
      <Group title="Models" count={data.models.length} action={["#/publish", "Publish a model"]}>
        {data.models.length === 0 && <span className="ide-none">No models listed</span>}
        {data.models.map((m) => {
          const href = `#/run/${m.key}`;
          return (
            <a key={m.key} href={href} aria-current={here(href)} title={`Run ${m.card.name}`}>
              <BrainCircuit size={13} strokeWidth={1.75} aria-hidden />
              <span className="ide-name">{m.card.id.split("/").pop()}</span>
              <span className="ide-meta">{Math.round(m.accuracy * 100)}%</span>
            </a>
          );
        })}
      </Group>
      <Group title="Creators" count={data.creators.length}>
        {data.creators.map((c) => {
          const href = `#/creators/${c}`;
          return (
            <a key={c} href={href} aria-current={here(href)}>
              <CodeXml size={13} strokeWidth={1.75} aria-hidden />
              <span className="ide-name">{label(c)}</span>
            </a>
          );
        })}
      </Group>
    </div>
  );
}

function Group({ title, count, action, children }: { title: string; count: number; action?: [string, string]; children: ReactNode }) {
  return (
    <section className="ex-card">
      <header>
        <h2>{title}</h2>
        <span className="ex-count">{count}</span>
        {action && (
          <a className="ex-act" href={action[0]}>
            <Plus size={14} strokeWidth={1.75} aria-hidden />
            {action[1]}
          </a>
        )}
      </header>
      <div className="ex-rows">{children}</div>
    </section>
  );
}

/** Failed checks and slashes, newest first: the console's "Problems". */
function problemsOf(snap: Snapshot) {
  return snap.receipts.filter((r) => ((r.t === "canary" || r.t === "known") && !r.pass) || r.t === "slash");
}

type PanelTab = "activity" | "problems";

/** The bell in the title bar: drops down the Activity and Problems log. */
function Panel({
  snap,
  problems,
  open,
  setOpen,
  tab,
  setTab,
}: {
  snap: Snapshot | null;
  problems: Snapshot["receipts"];
  open: boolean;
  setOpen: (v: boolean) => void;
  tab: PanelTab;
  setTab: (t: PanelTab) => void;
}) {
  const { label } = useLive();
  const wrap = useRef<HTMLDivElement>(null);
  const rows = tab === "activity" ? (snap?.receipts ?? []).slice(0, 80) : problems;

  // A click outside or Escape closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  return (
    <div className="ide-bell-wrap" ref={wrap}>
      <button className="ide-icon-btn ide-bell" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="ide-panel-log" title={`Activity and problems (${MOD}+J)`}>
        <Bell size={16} strokeWidth={1.75} aria-hidden />
        {problems.length > 0 && <span className="ide-bell-badge">{problems.length > 99 ? "99+" : problems.length}</span>}
        <span className="sr-only">Activity and problems</span>
      </button>
      {open && (
        <div className="ide-panel" role="dialog" aria-label="Activity and problems">
          <div className="ide-panel-head">
            <div role="tablist" aria-label="Panel" className="ide-panel-tabs">
              <button role="tab" aria-selected={tab === "activity"} aria-controls="ide-panel-log" onClick={() => setTab("activity")}>
                Activity
              </button>
              <button role="tab" aria-selected={tab === "problems"} aria-controls="ide-panel-log" onClick={() => setTab("problems")}>
                Problems <span className={`ide-count ${problems.length ? "bad" : ""}`}>{problems.length}</span>
              </button>
            </div>
          </div>
          <ul className="ide-log" id="ide-panel-log" role="tabpanel">
            {!snap && <li className="muted">Connecting…</li>}
            {snap && rows.length === 0 && <li className="muted">{tab === "activity" ? "No activity yet." : "No problems: every check passed and nothing was slashed."}</li>}
            {snap &&
              rows.map((r) => (
                <li key={r.seq}>
                  <span className="when">{timeOf(r)}</span>
                  <Tag tone={receiptTone(r)}>{receiptTag(r)}</Tag>
                  <span className="what">
                    <ReceiptText
                      r={r}
                      status={snap.status}
                      label={label}
                      openJob={(id) => {
                        setOpen(false);
                        go(`jobs/${id}`);
                      }}
                    />
                  </span>
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Command palette: jump to any view, job, model or GPU from the keyboard. */
function Palette({ snap, onClose }: { snap: Snapshot | null; onClose: () => void }) {
  const { label } = useLive();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const items = useMemo(() => {
    const list: { text: string; hint: string; href: string; Icon: IconT }[] = [
      ...ALL.map(([, href, text, Icon]) => ({ text: `Go to ${text}`, hint: "View", href, Icon })),
      { text: "Rent out a GPU", hint: "GPUs", href: "#/provide", Icon: Cpu },
      { text: "Browse the model hub", hint: "Models", href: "#/models", Icon: BrainCircuit },
      { text: "Back to the website", hint: "Website", href: "#/", Icon: ArrowLeft },
    ];
    if (snap) {
      for (const m of latestPerId(listingsOf(snap.status, snap.models))) list.push({ text: `Run ${m.card.name}`, hint: m.card.id, href: `#/run/${m.key}`, Icon: SquareTerminal });
      for (const j of sortedJobs(snap)) {
        const id = String(j.attrs.job_id);
        list.push({ text: `Open job ${short(id, 10)}`, hint: String(j.attrs.status), href: `#/jobs/${encodeURIComponent(id)}`, Icon: Workflow });
      }
      for (const o of snap.offers) list.push({ text: `GPU ${label(String(o.attrs.provider))}`, hint: "GPUs", href: "#/providers", Icon: Cpu });
    }
    return list;
  }, [snap, label]);
  const shown = items.filter((i) => `${i.text} ${i.hint}`.toLowerCase().includes(q.toLowerCase())).slice(0, 12);
  const pick = (i: number) => {
    const it = shown[i];
    if (!it) return;
    location.hash = it.href;
    onClose();
  };

  return (
    <div className="ide-palette-wrap" onMouseDown={onClose}>
      <div className="ide-palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ide-palette-input">
          <Search size={15} strokeWidth={1.75} aria-hidden />
          <input
            autoFocus
            value={q}
            placeholder="Type a view, model, job or GPU"
            aria-label="Search commands"
            aria-controls="ide-palette-list"
            aria-activedescendant={shown[sel] ? `ide-cmd-${sel}` : undefined}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, shown.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === "Enter") pick(sel);
            }}
          />
        </div>
        <ul id="ide-palette-list" role="listbox" className="ide-palette-list">
          {shown.length === 0 && <li className="muted">Nothing matches.</li>}
          {shown.map((it, i) => (
            <li key={`${it.href}-${it.text}`} id={`ide-cmd-${i}`} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => pick(i)}>
              <it.Icon size={15} strokeWidth={1.75} aria-hidden />
              <span>{it.text}</span>
              <span className="ide-meta">{it.hint}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
