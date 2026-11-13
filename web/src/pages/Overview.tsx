import { useMemo } from "react";
import { REPLAY, gpuState, hbar, jobStartedAt, listingsOf, refundsOf, short } from "../data";
import { go, useLive, type Snapshot } from "../live";
import { NetworkRing } from "../netring";
import { ReceiptText, StatusTag, Tag, receiptTag, receiptTone, timeOf } from "../ui";
import { latestPerId } from "./Models";

export function sortedJobs(snap: Snapshot) {
  return [...snap.jobs].sort((a, b) => (jobStartedAt(String(b.attrs.job_id)) ?? 0) - (jobStartedAt(String(a.attrs.job_id)) ?? 0));
}

// Console home: live network totals, the latest jobs and the latest HCS receipts.
export default function Overview({ snap }: { snap: Snapshot }) {
  const { label } = useLive();
  const { status, offers, jobs, receipts } = snap;
  const t = useMemo(() => {
    const canaries = receipts.filter((r) => r.t === "canary" || r.t === "known");
    return {
      checks: canaries.length,
      caught: canaries.filter((r) => !r.pass).length,
      refunded: refundsOf(receipts).reduce((a, r) => a + Number(r.refund), 0),
      royalties: receipts.filter((r) => r.t === "royalty").reduce((a, r) => a + Number(r.amount), 0),
    };
  }, [receipts]);
  const models = latestPerId(listingsOf(status, snap.models));
  const latest = sortedJobs(snap).slice(0, 5);

  return (
    <div className="page pg">
      <div className="pg-head pg-bar">
        <h1 className="sr-only">Overview</h1>
        {REPLAY && <Tag tone="warn">Synthetic replay: no network calls</Tag>}
        <a className="btn primary" href="#/run">
          Run a job
        </a>
      </div>

      <section className="kpis" aria-label="Network totals">
        <div className="kpi">
          <b>{models.length}</b>
          <span>Verified models</span>
        </div>
        <div className="kpi">
          <b>{offers.filter((o) => gpuState(snap, String(o.attrs.provider)) === "live").length}</b>
          <span>GPUs live</span>
        </div>
        <div className="kpi">
          <b>{jobs.length}</b>
          <span>Jobs run</span>
        </div>
        <div className="kpi">
          <b>{hbar(t.royalties)}</b>
          <span>Paid to creators</span>
        </div>
      </section>

      <section className="kpis" aria-label="Checks and refunds">
        <div className="kpi">
          <b>{t.checks}</b>
          <span>Checks run</span>
        </div>
        <div className="kpi">
          <b>{t.caught}</b>
          <span>Checks failed</span>
        </div>
        <div className="kpi">
          <b>{hbar(t.refunded)}</b>
          <span>Refunded to buyers</span>
        </div>
        <div className="kpi">
          <b>{status.network}</b>
          <span>Network</span>
        </div>
      </section>

      <section className="panel section net-panel" aria-labelledby="net-h">
        <div className="panel-head">
          <span className="label" id="net-h">
            Network
          </span>
          <a className="link small" href="#/providers">
            All GPUs →
          </a>
        </div>
        <NetworkRing />
      </section>

      <div className="grid-2 section">
        <div className="panel">
          <div className="panel-head">
            <span className="label">Recent jobs</span>
            <a className="link small" href="#/jobs">
              All jobs →
            </a>
          </div>
          {latest.length === 0 && <div className="empty">No jobs yet.</div>}
          <ul className="feed">
            {latest.map((job) => {
              const id = String(job.attrs.job_id);
              return (
                <li key={job.key}>
                  <a className="mono" href={`#/jobs/${encodeURIComponent(id)}`} style={{ flex: 1 }}>
                    {short(id, 12)}
                  </a>
                  <span className="muted small">
                    {Number(job.attrs.done)}/{Number(job.attrs.total)} chunks
                  </span>
                  <StatusTag status={String(job.attrs.status)} />
                </li>
              );
            })}
          </ul>
        </div>
        <div className="panel">
          <div className="panel-head">
            <span className="label">Live activity</span>
            <a className="link small" href="#/audit">
              Audit trail →
            </a>
          </div>
          <ul className="feed">
            {receipts.length === 0 && <li className="muted">No activity yet.</li>}
            {receipts.slice(0, 5).map((r) => (
              <li key={r.seq}>
                <span className="when">{timeOf(r)}</span>
                <span style={{ minWidth: 0 }}>
                  <Tag tone={receiptTone(r)}>{receiptTag(r)}</Tag> <ReceiptText r={r} status={status} label={label} openJob={(id) => go(`jobs/${id}`)} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
