import { useEffect, useMemo, useState } from "react";
import { Cpu } from "lucide-react";
import { DEMO, hbar, listingsOf, money, providerColor, refundsOf, short, sumByAsset, sumsText, VERIFIER_URL, writtenBy } from "../data";
import { useLive, type Snapshot } from "../live";
import { StatusTag } from "../ui";

type Row = ReturnType<typeof useRows>[number];

function useRows(snap: Snapshot) {
  const { label, gpu } = useLive();
  const { status, offers, reputations, receipts, claims } = snap;
  return useMemo(() => {
    // Earnings per provider and per asset (older jobs paid in HBAR, newer ones may be in a token).
    const paid = new Map<string, Map<string, number>>();
    const refunded = new Map<string, number>();
    for (const r of receipts) {
      if (refundsOf([r]).length) refunded.set(String(r.provider), (refunded.get(String(r.provider)) ?? 0) + Number(r.refund));
    }
    const payments = receipts.filter((r) => r.t === "chunk");
    for (const p of new Set(payments.map((r) => String(r.provider)))) paid.set(p, sumByAsset(payments.filter((r) => r.provider === p), "amount"));
    let addrs = new Set<string>([...offers.map((o) => String(o.attrs.provider)), ...reputations.map((r) => String(r.attrs.provider)), ...paid.keys()]);
    if (DEMO) {
      // Presentation view: only providers with a live offer or in the latest job (receipts are newest first).
      const lastJob = receipts.find((r) => r.t === "job")?.job;
      const current = new Set([...offers.map((o) => String(o.attrs.provider)), ...receipts.filter((r) => lastJob && r.job === lastJob && r.provider).map((r) => String(r.provider))]);
      addrs = new Set([...addrs].filter((a) => current.has(a)));
    }
    return [...addrs].map((addr) => {
      const offer = offers.find((o) => o.attrs.provider === addr && writtenBy(o, addr));
      const rep = reputations.find((r) => r.attrs.provider === addr && writtenBy(r, status.verifier));
      const pass = Number(rep?.attrs.pass ?? 0);
      const fail = Number(rep?.attrs.fail ?? 0);
      return {
        addr,
        name: label(addr),
        gpu: gpu(addr),
        price: offer?.attrs.price as number | undefined,
        bond: offer?.attrs.bond as number | undefined,
        backend: offer?.payload?.backend as string | undefined,
        // Kept on the reputation too, so a slashed or offline provider stays labelled.
        adversarial: (offer?.attrs.adversarial ?? rep?.attrs.adversarial) as string | undefined,
        pass,
        fail,
        score: pass + fail > 0 ? Number(rep?.attrs.score) : null,
        qual: rep?.attrs.qual_status as string | undefined,
        qualAgreement: rep?.attrs.qual_agreement === undefined ? undefined : Number(rep.attrs.qual_agreement),
        // Model check: does it answer like the model it declares?
        fp: rep?.attrs.fp_status ? { status: String(rep.attrs.fp_status), match: Number(rep.attrs.fp_match ?? 0), model: String(rep.attrs.fp_model ?? ""), closest: rep.attrs.fp_closest as string | undefined } : undefined,
        latency: rep?.attrs.latency_ms ? Number(rep.attrs.latency_ms) : undefined,
        state: rep?.attrs.status === "slashed" ? "slashed" : rep?.attrs.qual_status === "rejected" ? "rejected" : offer ? "live" : "offline",
        busy: claims.filter((c) => c.attrs.provider === addr).length,
        paid: paid.get(addr) ?? new Map<string, number>(),
        earnedTotal: [...(paid.get(addr)?.values() ?? [])].reduce((a, b) => a + b, 0),
        uaid: (offer?.attrs.uaid ?? rep?.attrs.uaid) as string | undefined,
        refunded: refunded.get(addr) ?? 0,
        // Listed models it serves (one `model.<key>` attribute each) and how it says it isolates them.
        models: offer ? Object.keys(offer.attrs).filter((k) => k.startsWith("model.")).map((k) => k.slice(6)) : [],
        sandbox: offer?.attrs.sandbox as string | undefined,
        // Its ERC-8004 identity on 0G Chain, and the transaction that registered it.
        erc8004: offer?.attrs.erc8004 === undefined ? undefined : Number(offer.attrs.erc8004),
        erc8004Tx: (offer?.payload as { erc8004?: { tx?: string } } | null)?.erc8004?.tx,
      };
    });
  }, [offers, reputations, receipts, claims, status.verifier, label, gpu]);
}

const FILTERS = ["all", "live", "rejected", "slashed", "offline"] as const;
const SORTS: [string, string, (a: Row, b: Row) => number][] = [
  ["score", "Score", (a, b) => (b.score ?? -1) - (a.score ?? -1)],
  ["price", "Price", (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity)],
  ["latency", "Latency", (a, b) => (a.latency ?? Infinity) - (b.latency ?? Infinity)],
  ["earned", "Earned", (a, b) => b.earnedTotal - a.earnedTotal],
];

// Available GPUs first, then the ones that can't take work.
const STATE_ORDER: Record<string, number> = { live: 0, offline: 1, rejected: 2, slashed: 3 };

const ms = (v?: number) => (v ? `${(v / 1000).toFixed(1)} s` : "—");

/** The ERC-8004 reputation the verifier gave each agent, read back from 0G Chain. */
type Reputation = { agentId: number; jobs: number; successRate: number | null; slashes: number };

function useErc8004(ids: number[]) {
  const [rep, setRep] = useState<Map<number, Reputation>>(new Map());
  const key = ids.sort((a, b) => a - b).join(",");
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const tick = () =>
      fetch(`${VERIFIER_URL}/erc8004/reputation?ids=${key}`)
        .then((r) => r.json())
        .then((b: { agents?: Reputation[] }) => alive && setRep(new Map((b.agents ?? []).map((a) => [a.agentId, a]))))
        .catch(() => {});
    void tick();
    const t = setInterval(tick, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [key]);
  return rep;
}

export default function Providers({ snap }: { snap: Snapshot }) {
  const rows = useRows(snap);
  const erc = snap.status.erc8004;
  const reputation = useErc8004(rows.map((r) => r.erc8004).filter((n): n is number => n !== undefined));
  const ercLink = (tx?: string) => (erc && tx ? `${erc.explorerUrl}/tx/${tx}` : undefined);
  const listings = listingsOf(snap.status, snap.models);
  const modelName = (key: string) => {
    const l = listings.find((x) => x.key === key);
    return l ? `${l.card.name} v${l.card.version}` : key;
  };
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [sort, setSort] = useState("score");
  const [open, setOpen] = useState<string | null>(null);
  const shown = rows.filter((r) => filter === "all" || r.state === filter).sort((a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) || SORTS.find((s) => s[0] === sort)![2](a, b));
  const live = rows.filter((r) => r.state === "live");
  const prices = live.map((r) => r.price).filter((p): p is number => p !== undefined);
  const passed = rows.reduce((a, r) => a + r.pass, 0);
  const checked = rows.reduce((a, r) => a + r.pass + r.fail, 0);
  const refunded = rows.reduce((a, r) => a + r.refunded, 0);

  return (
    <div className="page pg">
      <div className="phead pg-bar">
        <h1 className="sr-only">GPUs</h1>
        <span className="small muted">{rows.length} GPU{rows.length === 1 ? "" : "s"}</span>
        <a className="btn" href="#/provide">
          Rent out a GPU
        </a>
      </div>

      <section className="kpis" aria-label="GPU totals">
        <div className="kpi">
          <b>{live.length}</b>
          <span>Live now</span>
        </div>
        <div className="kpi">
          <b>{prices.length ? money(snap.status, Math.min(...prices)) : "—"}</b>
          <span>Cheapest per chunk</span>
        </div>
        <div className="kpi">
          <b>{checked ? `${Math.round((passed / checked) * 100)}%` : "—"}</b>
          <span title={`${passed} of ${checked} canary checks passed`}>Checks passed</span>
        </div>
        <div className="kpi">
          <b>{hbar(refunded)}</b>
          <span>Refunded from bonds</span>
        </div>
      </section>

      <div className="toolbar">
        <div className="chips" role="group" aria-label="Filter providers">
          {FILTERS.map((f) => (
            <button key={f} className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f[0].toUpperCase() + f.slice(1)}
              <span className="n">{f === "all" ? rows.length : rows.filter((r) => r.state === f).length}</span>
            </button>
          ))}
        </div>
        <select className="hub-sort" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort providers">
          {SORTS.map(([id, text]) => (
            <option key={id} value={id}>
              Sort: {text}
            </option>
          ))}
        </select>
      </div>

      {shown.length === 0 ? (
        <div className="empty-hub">No providers here.</div>
      ) : (
        <div className="gtiles">
          {shown.map((p) => {
            const checks = p.pass + p.fail;
            const isOpen = open === p.addr;
            return (
              <article key={p.addr} className={`gtile ${p.state} ${isOpen ? "open" : ""}`}>
                <header className="gtile-head">
                  <span className="gtile-icon" style={{ color: providerColor(p.addr) }} aria-hidden>
                    <Cpu size={20} strokeWidth={1.75} />
                  </span>
                  <div className="gtile-id">
                    <span className="gpu-name">
                      {p.name}
                      {p.adversarial && !DEMO && (
                        <span className="test-pill" title={`Adversarial test provider: ${p.adversarial}`}>
                          test
                        </span>
                      )}
                    </span>
                    <span className="gtile-sub">{p.gpu}</span>
                  </div>
                </header>

                <div className="gtile-price">
                  <span>
                    <b>{p.price === undefined ? "—" : money(snap.status, p.price)}</b>
                    <span>per chunk</span>
                  </span>
                  <StatusTag status={p.state} />
                </div>

                <dl className="gtile-specs">
                  <div>
                    <dt>Bond</dt>
                    <dd>{p.bond === undefined ? "—" : hbar(p.bond)}</dd>
                  </div>
                  <div>
                    <dt>Latency</dt>
                    <dd>{ms(p.latency)}</dd>
                  </div>
                  <div>
                    <dt>Earned</dt>
                    <dd>{sumsText(snap.status, p.paid)}</dd>
                  </div>
                  <div>
                    <dt>Right now</dt>
                    <dd>{p.busy ? `${p.busy} chunk${p.busy === 1 ? "" : "s"} in flight` : p.state === "live" ? "Idle" : "—"}</dd>
                  </div>
                </dl>

                <div className="gtile-checks" title={`${p.pass} passed · ${p.fail} failed${p.score !== null ? ` · score ${p.score}` : ""}`}>
                  <span className="score">
                    <span className="bar" aria-hidden>
                      <span style={{ width: checks ? `${(p.pass / checks) * 100}%` : 0 }} />
                      <span style={{ width: checks ? `${(p.fail / checks) * 100}%` : 0 }} />
                    </span>
                  </span>
                  <span>
                    {p.pass} passed · <span className={p.fail ? "bad" : "muted"}>{p.fail} failed</span>
                  </span>
                </div>

                <div className="gtile-serves">
                  <span className="muted">Serves</span>{" "}
                  {p.models.length === 0 ? (
                    <span>Built-in tasks</span>
                  ) : (
                    <span title={p.models.map(modelName).join(", ")}>
                      <a className="link" href={`#/models/${p.models[0]}`}>
                        {modelName(p.models[0])}
                      </a>
                      {p.models.length > 1 && <span className="muted"> +{p.models.length - 1}</span>}
                    </span>
                  )}
                </div>

                <footer className="gtile-foot">
                  <button className="btn sm" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : p.addr)}>
                    {isOpen ? "Hide details" : "Details"}
                  </button>
                  {p.erc8004 !== undefined && (
                    <a className="erc-pill" href={ercLink(p.erc8004Tx)} target="_blank" rel="noreferrer" title="ERC-8004 agent on 0G Chain: its identity and reputation">
                      ERC-8004 #{p.erc8004}
                    </a>
                  )}
                </footer>

                {isOpen && (
                  <dl className="facts gtile-more">
                    <div>
                      <dt>Status</dt>
                      <dd>
                        <StatusTag status={p.state} />
                      </dd>
                    </div>
                    {p.erc8004 !== undefined && (
                      <div>
                        <dt>On-chain reputation</dt>
                        <dd title="ERC-8004 reputation on 0G: share of hidden checks passed, per job.">
                          {(() => {
                            const r = reputation.get(p.erc8004!);
                            if (!r || r.jobs === 0) return <span className="muted">ERC-8004 #{p.erc8004} · no jobs rated yet</span>;
                            return (
                              <>
                                <b className={r.successRate !== null && r.successRate >= 80 ? "ok" : "bad"}>{Math.round(r.successRate ?? 0)}%</b> of checks over {r.jobs} job{r.jobs === 1 ? "" : "s"}
                                {r.slashes > 0 && <span className="bad"> · {r.slashes} slashed</span>}
                              </>
                            );
                          })()}
                        </dd>
                      </div>
                    )}
                    <div>
                      <dt>Admission</dt>
                      <dd className={p.qual === "admitted" ? "ok" : p.qual ? "bad" : "muted"}>{p.qual ? `${p.qual === "admitted" ? "✓ Admitted" : "✗ Rejected"} · ${p.qualAgreement}% of known answers` : "Not probed"}</dd>
                    </div>
                    <div>
                      <dt>Model check</dt>
                      <dd className={p.fp?.status === "consistent" ? "ok" : p.fp?.status === "mismatch" ? "bad" : "muted"} title={p.fp ? `declared ${modelName(p.fp.model)}${p.fp.closest ? `; closest known model: ${p.fp.closest}` : ""}` : undefined}>
                        {p.fp ? `${p.fp.status === "consistent" ? "✓ Matches" : p.fp.status === "mismatch" ? "✗ Doesn't match" : "? Unclear"} · ${p.fp.match}%` : "Not checked"}
                      </dd>
                    </div>
                    <div>
                      <dt>Serves</dt>
                      <dd>
                        {p.models.length === 0
                          ? "Built-in tasks"
                          : p.models.map((k, i) => (
                              <span key={k}>
                                {i > 0 && ", "}
                                <a className="link" href={`#/models/${k}`}>
                                  {modelName(k)}
                                </a>
                              </span>
                            ))}
                      </dd>
                    </div>
                    <div>
                      <dt>Canary checks</dt>
                      <dd>
                        {p.pass} passed · <span className={p.fail ? "bad" : ""}>{p.fail} failed</span>
                        {p.score !== null && <span className="muted"> · score {p.score}</span>}
                      </dd>
                    </div>
                    <div>
                      <dt>Bond</dt>
                      <dd>{p.bond === undefined ? "—" : hbar(p.bond)}</dd>
                    </div>
                    <div>
                      <dt>Refunded from bond</dt>
                      <dd className={p.refunded ? "bad" : ""}>{p.refunded ? hbar(p.refunded) : "—"}</dd>
                    </div>
                    <div>
                      <dt>Earned</dt>
                      <dd>{sumsText(snap.status, p.paid)}</dd>
                    </div>
                    <div>
                      <dt>Latency</dt>
                      <dd>{ms(p.latency)}</dd>
                    </div>
                    <div>
                      <dt>Runtime</dt>
                      <dd className="mono small">
                        {p.gpu}
                        {p.backend ? ` · ${p.backend}` : ""}
                      </dd>
                    </div>
                    {p.sandbox && (
                      <div>
                        <dt title="Declared in its offer; KINETIC can't prove it">Sandbox (declared)</dt>
                        <dd>{p.sandbox}</dd>
                      </div>
                    )}
                    <div>
                      <dt>Identity</dt>
                      <dd className="mono small" title={p.uaid ?? "no HCS-14 identity published"}>
                        {p.uaid ? `HCS-14 ${short(p.uaid.split(";")[0].replace("uaid:aid:", ""), 6)}` : short(p.addr)}
                      </dd>
                    </div>
                    <div>
                      <dt>Right now</dt>
                      <dd>{p.busy ? `${p.busy} chunk${p.busy === 1 ? "" : "s"} in flight` : p.state === "live" ? "Idle" : "—"}</dd>
                    </div>
                    {p.adversarial && !DEMO && (
                      <div>
                        <dt>Test provider</dt>
                        <dd className="warn">{p.adversarial}</dd>
                      </div>
                    )}
                  </dl>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
