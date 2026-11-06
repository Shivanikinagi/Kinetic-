import { useMemo, useState } from "react";
import { hashscan, hbar, listingsOf, short } from "../data";
import { go, type Snapshot } from "../live";
import { TxLink, timeOf } from "../ui";
import { Avatar } from "./Models";

// A creator's dashboard: their listed models and every royalty those models earned, read from
// the listings on Arkiv and the royalty receipts on HCS. Each payment links to its transaction.

export default function Creators({ snap, creator: initial }: { snap: Snapshot; creator?: string }) {
  const { status } = snap;
  const listings = listingsOf(status, snap.models);
  const creators = useMemo(() => [...new Set(listings.map((l) => l.card.creator.address))], [listings]);
  const [creator, setCreator] = useState(initial ?? "");
  const me = creator && creators.includes(creator) ? creator : creators[0];
  const mine = listings.filter((l) => l.card.creator.address === me);
  const keys = new Set(mine.map((m) => m.key));
  const payments = snap.receipts.filter((r) => r.t === "royalty" && keys.has(String(r.model)));
  const earned = payments.reduce((a, r) => a + Number(r.amount), 0);
  // Jobs from their HCS receipts, which name the model and never expire (Arkiv entities do).
  const jobReceipts = snap.receipts.filter((r) => r.t === "job" && r.model && keys.has(String(r.model)));
  const jobsOf = (key: string) => new Set(jobReceipts.filter((r) => r.model === key).map((r) => String(r.job))).size;
  const jobs = new Set(jobReceipts.map((r) => String(r.job)));
  const serving = (key: string) => snap.offers.filter((o) => o.attrs[`model.${key}`] !== undefined).length;
  const byModel = (key: string) => payments.filter((r) => r.model === key).reduce((a, r) => a + Number(r.amount), 0);
  const avg = mine.length ? mine.reduce((a, m) => a + m.accuracy, 0) / mine.length : 0;
  const payTo = mine[0]?.card.creator.payTo;
  const account = payTo ? hashscan(status, "account", payTo) : null;
  const nameOf = (key: string) => mine.find((m) => m.key === key)?.card.id ?? key;

  return (
    <div className="page pg">
      <div className="pg-head pg-bar">
        <h1 className="sr-only">Creator dashboard</h1>
        <span className="small muted">
          Paid to{" "}
          {account ? (
            <a className="ext mono" href={account} target="_blank" rel="noreferrer">
              {payTo}
            </a>
          ) : (
            <span className="mono">{payTo ?? "—"}</span>
          )}
        </span>
        <div className="row-gap">
          {creators.length > 1 && (
            <select className="hub-sort" value={me} onChange={(e) => setCreator(e.target.value)} aria-label="Creator">
              {creators.map((c) => (
                <option key={c} value={c}>
                  {short(c, 6)}
                </option>
              ))}
            </select>
          )}
          <a className="btn primary" href="#/publish">
            + Publish a model
          </a>
        </div>
      </div>

      <section className="kpis" aria-label="Creator totals">
        <div className="kpi">
          <b>{mine.length}</b>
          <span>Verified models</span>
        </div>
        <div className="kpi">
          <b className={earned ? "ok" : ""}>{hbar(earned)}</b>
          <span>Royalties earned</span>
        </div>
        <div className="kpi">
          <b>{jobs.size}</b>
          <span>Jobs run on your models</span>
        </div>
        <div className="kpi">
          <b>{Math.round(avg * 100)}%</b>
          <span>Average benchmark</span>
        </div>
      </section>

      <div className="h2row">
        <h2>Your models</h2>
      </div>
      {mine.length === 0 ? (
        <div className="empty-hub">No models yet. Publish one and earn on every job that runs it.</div>
      ) : (
        <div className="files-wrap">
          <table className="files clickable">
            <thead>
              <tr>
                <th>Model</th>
                <th className="num">Benchmark</th>
                <th className="num">Royalty</th>
                <th className="num">GPUs</th>
                <th className="num">Jobs</th>
                <th className="num">Earned</th>
                <th>Passport</th>
              </tr>
            </thead>
            <tbody>
              {mine.map((m) => (
                <tr key={m.key} onClick={() => go(`models/${m.key}`)}>
                  <td>
                    <span className="row-gap">
                      <Avatar m={m} />
                      <span>
                        <b>{m.card.id}</b> <span className="muted">v{m.card.version}</span>
                      </span>
                    </span>
                  </td>
                  <td className="num">{Math.round(m.accuracy * 100)}%</td>
                  <td className="num">{m.card.royaltyBps / 100}%</td>
                  <td className="num">{serving(m.key)}</td>
                  <td className="num">{jobsOf(m.key)}</td>
                  <td className="num">{hbar(byModel(m.key))}</td>
                  <td>
                    <span className="verified">✓ {m.signers.length} verifiers</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="h2row">
        <h2>Royalty payments</h2>
        <span className="muted small">{payments.length} payments</span>
      </div>
      {payments.length === 0 ? (
        <div className="empty-hub">No royalties yet. They're paid after each job on accepted chunks.</div>
      ) : (
        <div className="panel">
          <ul className="feed">
            {payments.slice(0, 30).map((r) => (
              <li key={r.seq}>
                <span className="when">{timeOf(r)}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <b className="ok">{hbar(r.amount as string)}</b> from{" "}
                  <a className="link mono" href={`#/jobs/${encodeURIComponent(String(r.job))}`}>
                    {short(String(r.job), 8)}
                  </a>{" "}
                  · {nameOf(String(r.model))} · {Number(r.chunks)} accepted chunk{Number(r.chunks) === 1 ? "" : "s"}
                </span>
                <TxLink status={status} id={String(r.tx)} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
