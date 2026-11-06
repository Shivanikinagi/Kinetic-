import { useEffect, useState } from "react";
import { go, useLive, type Snapshot } from "../live";
import { RECEIPT_GROUPS, ReceiptText, Tag, TxLink, receiptTag, receiptTone, timeOf } from "../ui";

/** The scroll container the page lives in: the console's editor, or the window on the website. */
const scroller = () => document.getElementById("main")?.closest(".ide-content") ?? null;
const scrollTop = () => scroller()?.scrollTop ?? window.scrollY;

export default function Audit({ snap }: { snap: Snapshot }) {
  const { label } = useLive();
  const [filter, setFilter] = useState("all");
  const [limit, setLimit] = useState(50);
  const { status, receipts } = snap;
  const newest = receipts[0]?.seq ?? 0;
  // New receipts arrive at the top. While you're reading further down they wait behind a button
  // instead of pushing the list out from under you.
  const [upTo, setUpTo] = useState(newest);
  useEffect(() => {
    if (scrollTop() < 40) setUpTo(newest);
  }, [newest]);
  const pick = (id: string) => {
    setFilter(id);
    setLimit(50);
  };
  const visible = receipts.filter((r) => r.seq <= upTo);
  const waiting = receipts.length - visible.length;
  // A filter is "all", a group ("group:payments") or one type ("royalty").
  const groupTypes = (g: string) => RECEIPT_GROUPS.find(([id]) => id === g)?.[2].map(([t]) => t) ?? [];
  const matches = (id: string) => (id === "all" ? () => true : id.startsWith("group:") ? (r: { t: string }) => groupTypes(id.slice(6)).includes(r.t) : (r: { t: string }) => r.t === id);
  const shown = visible.filter(matches(filter));
  const count = (id: string) => visible.filter(matches(id)).length;
  // Types with no receipts yet are hidden (unless picked), and so are groups left empty.
  const groups = RECEIPT_GROUPS.map(([g, name, types]) => [g, name, types.filter(([id]) => id === filter || count(id) > 0)] as const).filter(([g, , types]) => types.length > 0 || filter === `group:${g}`);
  const showNew = () => {
    setUpTo(newest);
    const el = scroller();
    if (el) el.scrollTo({ top: 0 });
    else window.scrollTo({ top: 0 });
  };

  return (
    <div className="page pg">
      <div className="phead pg-bar">
        <h1 className="sr-only">Audit trail</h1>
        <span className="small muted" title="Verifier-only HCS topic, read from the mirror node">
          {receipts.length} receipts · Topic <TxLink status={status} kind="topic" id={status.hcsTopic} text={status.hcsTopic} />
        </span>
      </div>

      <div className="hub">
        <aside className="facets" aria-label="Filter receipts">
          <div className="facet">
            <ul className="flist">
              <li>
                <button aria-pressed={filter === "all"} onClick={() => pick("all")}>
                  All receipts
                  <span className="n">{count("all")}</span>
                </button>
              </li>
            </ul>
            {groups.map(([g, name, types]) => (
              <div key={g} className="flist-group">
                <button className="flist-head" aria-pressed={filter === `group:${g}`} onClick={() => pick(`group:${g}`)}>
                  {name}
                  <span className="n">{count(`group:${g}`)}</span>
                </button>
                <ul className="flist">
                  {types.map(([id, text]) => (
                    <li key={id}>
                      <button aria-pressed={filter === id} onClick={() => pick(id)}>
                        {text}
                        <span className="n">{count(id)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <select className="flist-select hub-sort" value={filter} onChange={(e) => pick(e.target.value)} aria-label="Receipt type">
              <option value="all">All receipts ({count("all")})</option>
              {groups.map(([g, name, types]) => (
                <optgroup key={g} label={name}>
                  <option value={`group:${g}`}>
                    All {name.toLowerCase()} ({count(`group:${g}`)})
                  </option>
                  {types.map(([id, text]) => (
                    <option key={id} value={id}>
                      {text} ({count(id)})
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        </aside>

        <section className="audit" style={{ minWidth: 0 }}>
          {waiting > 0 && (
            <button className="audit-new" onClick={showNew}>
              ↑ {waiting} new receipt{waiting === 1 ? "" : "s"}
            </button>
          )}
          <div className="audit-head" aria-hidden>
            <span>#</span>
            <span>Time</span>
            <span>Type</span>
            <span>Receipt</span>
          </div>
          <ol className="audit-rows">
            {shown.length === 0 && <li className="muted">No receipts.</li>}
            {shown.slice(0, limit).map((r) => (
              <li key={r.seq}>
                <span className="seq">{r.seq}</span>
                <span className="when">{timeOf(r)}</span>
                <span className="kind">
                  <Tag tone={receiptTone(r)}>{receiptTag(r)}</Tag>
                </span>
                <span className="what">
                  <ReceiptText r={r} status={status} label={label} openJob={(id) => go(`jobs/${id}`)} />
                </span>
              </li>
            ))}
          </ol>
          {shown.length > limit && (
            <div className="show-more">
              <button className="btn sm" onClick={() => setLimit(limit + 50)}>
                Show more
              </button>
              <span className="small muted">
                {limit} of {shown.length}
              </span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
