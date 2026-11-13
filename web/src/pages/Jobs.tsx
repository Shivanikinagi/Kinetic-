import { useEffect, useState, type ReactNode } from "react";
import { amountOf, getCanaries, hbar, isStorageRef, jobStartedAt, listingsOf, refundsOf, short, storageLink, type CanaryResult, type Entity, type ModelListing, type Receipt } from "../data";
import { go, useLive, type Snapshot } from "../live";
import { ChunkGrid, Diff, Meter, Progress, ProviderName, ReceiptText, StatusTag, Tag, TxLink, receiptTag, receiptTone, timeOf } from "../ui";
import { sortedJobs } from "./Overview";

/** The listed model a job ran, from its Arkiv entity (key on the job, name from the registry or the job's payload). */
function jobModel(job: Entity, listings: ModelListing[]): { key: string; name: string; listing?: ModelListing } | undefined {
  const key = job.attrs.model ? String(job.attrs.model) : undefined;
  if (!key) return undefined;
  const listing = listings.find((l) => l.key === key);
  const payload = (job.payload as { model?: { id?: string; version?: string } } | null)?.model;
  return { key, listing, name: listing ? `${listing.card.id}@${listing.card.version}` : payload?.id ? `${payload.id}@${payload.version}` : key };
}

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

export function JobList({ snap }: { snap: Snapshot }) {
  const jobs = sortedJobs(snap);
  const listings = listingsOf(snap.status, snap.models);
  return (
    <div className="page pg">
      <div className="phead pg-bar">
        <h1 className="sr-only">Jobs</h1>
        <span className="small muted">{jobs.length} job{jobs.length === 1 ? "" : "s"}</span>
        <a className="btn primary" href="#/run">
          Run a job
        </a>
      </div>

      {jobs.length === 0 ? (
        <div className="empty-hub">No jobs yet.</div>
      ) : (
        <div className="files-wrap">
          <table className="files">
            <thead>
              <tr>
                <th>Job</th>
                <th className="hide-sm">Model</th>
                <th>Chunks</th>
                <th className="num">Paid</th>
                <th className="hide-md">Started</th>
                <th className="hide-sm">Status</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const id = String(job.attrs.job_id);
                const own = snap.chunks.filter((c) => c.attrs.job_id === id);
                const receipts = snap.receipts.filter((r) => r.job === id);
                const refunded = refundsOf(receipts).reduce((a, r) => a + Number(r.refund), 0);
                const paid = receipts.filter((r) => r.t === "chunk").reduce((a, r) => a + Number(r.amount), 0);
                const asset = receipts.find((r) => r.t === "chunk")?.asset;
                const model = jobModel(job, listings);
                const rerouted = Number(job.attrs.rerouted ?? 0);
                const href = `#/jobs/${encodeURIComponent(id)}`;
                return (
                  <tr key={job.key} className="go" onClick={() => go(`jobs/${encodeURIComponent(id)}`)}>
                    <td>
                      <a className="id" href={href} onClick={(e) => e.stopPropagation()}>
                        {short(id, 12)}
                      </a>
                      <span className="show-sm">
                        <StatusTag status={String(job.attrs.status)} />
                      </span>
                    </td>
                    <td className="hide-sm">
                      {model ? <span title={model.name}>{model.listing?.card.name ?? model.name}</span> : <span className="muted">{String(job.attrs.task)}</span>}
                    </td>
                    <td>
                      <span className="prog" title={`${Number(job.attrs.done)} of ${Number(job.attrs.total)} chunks final · ${rerouted} rerouted`}>
                        <Progress chunks={own} total={Number(job.attrs.total)} />
                        <span>
                          {Number(job.attrs.done)}/{Number(job.attrs.total)}
                        </span>
                      </span>
                    </td>
                    <td className="num">
                      {amountOf(snap.status, paid, asset)}
                      {refunded ? <span className="sub bad">−{hbar(refunded)} refunded</span> : null}
                      {job.attrs.royalty ? <span className="sub ok">{hbar(job.attrs.royalty as number)} royalty</span> : null}
                    </td>
                    <td className="hide-md muted">{when(jobStartedAt(id))}</td>
                    <td className="hide-sm">
                      <StatusTag status={String(job.attrs.status)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type Tab = "chunks" | "checks" | "payments" | "receipts";

export function JobDetail({ snap, jobId }: { snap: Snapshot; jobId: string }) {
  const { label } = useLive();
  const { status, chunks, receipts } = snap;
  const job = snap.jobs.find((j) => j.attrs.job_id === jobId);
  const [canaries, setCanaries] = useState<CanaryResult[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [tab, setTab] = useState<Tab>("chunks");

  useEffect(() => {
    let alive = true;
    const tick = () => getCanaries(jobId).then((c) => alive && setCanaries(c));
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [jobId]);

  if (!job) {
    // A job that just started is registered on Arkiv a few seconds after the run begins, and
    // the dashboard reads Arkiv every few seconds: that's "starting", not missing. An older one
    // whose entity expired (or lived on a previous Arkiv network) still has its HCS receipts.
    const started = jobStartedAt(jobId);
    const fresh = started !== null && Date.now() - started < 3 * 60_000;
    const kept = receipts.filter((r) => r.job === jobId);
    return (
      <div className="page pg">
        <a className="back link" href="#/jobs">
          ← Jobs
        </a>
        {fresh ? (
          <div className="empty-hub">
            <span className="spinner" aria-hidden /> Starting <span className="mono">{jobId}</span>: registering it on Arkiv and committing its rules on Hedera. This page fills in by itself.
          </div>
        ) : kept.length ? (
          <>
            <div className="empty-hub" title="Job entities expire from Arkiv after 7 days">
              <span className="mono">{jobId}</span>'s Arkiv entry has expired, but its receipts on Hedera are permanent:
            </div>
            <ul className="feed panel" style={{ marginTop: 14 }}>
              {kept.slice(0, 40).map((r) => (
                <li key={r.seq}>
                  <span className="when">{timeOf(r)}</span>
                  <span style={{ minWidth: 0 }}>
                    <Tag tone={receiptTone(r)}>{receiptTag(r)}</Tag> <ReceiptText r={r} status={status} label={label} />
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="empty-hub">No job <span className="mono">{jobId}</span> on Arkiv or Hedera.</div>
        )}
      </div>
    );
  }

  const own = chunks.filter((c) => c.attrs.job_id === jobId).sort((a, b) => Number(a.attrs.idx) - Number(b.attrs.idx));
  const mine = receipts.filter((r) => r.job === jobId);
  const registered = mine.find((r) => r.t === "job");
  const done = mine.find((r) => r.t === "done");
  const reveal = mine.find((r) => r.t === "reveal");
  // One HCS Merkle anchor over the finished chunks, and the PRNG spot checks after the job.
  const anchor = mine.find((r) => r.t === "anchor");
  const spot = mine.find((r) => r.t === "spot");
  const spotChecked = (spot?.checked as { idx: number; pass?: boolean }[] | undefined) ?? [];
  const slashes = mine.filter((r) => r.t === "slash");
  const settles = mine.filter((r) => r.t === "settle");
  const royaltyReceipt = mine.find((r) => r.t === "royalty");
  const royalty = Number(royaltyReceipt?.amount ?? job.attrs.royalty ?? 0);
  const model = jobModel(job, listingsOf(status, snap.models));
  const malformed = mine.filter((r) => r.t === "format");
  const payments = mine.filter((r) => r.t === "chunk");
  // Chunks that ran on a named 0G Compute provider, with the verifier's attestation check.
  const runs = payments.filter((r) => r.zg).sort((a, b) => Number(a.idx) - Number(b.idx));
  const canaryByIdx = new Map<number, boolean>(canaries.map((c) => [c.idx, c.pass]));

  // Admission probes carry no job id: show the ones recorded while this job was being set up.
  const startedMs = jobStartedAt(jobId);
  const startedSec = (startedMs ?? 0) / 1000;
  const endSec = done ? Number(done.ts.split(".")[0]) : Infinity;
  const quals = receipts.filter((r) => r.t === "qualify" && Number(r.ts.split(".")[0]) >= startedSec - 5 && Number(r.ts.split(".")[0]) <= endSec);

  const perProvider = new Map<string, { paid: number; chunks: number; refund: number; vaultTx?: string; payTx?: string }>();
  for (const r of [...payments, ...refundsOf(mine)]) {
    const p = String(r.provider);
    const row = perProvider.get(p) ?? { paid: 0, chunks: 0, refund: 0 };
    if (r.t === "chunk") {
      row.paid += Number(r.amount);
      row.chunks += 1;
      row.payTx ??= String(r.payTx);
    } else {
      row.refund += Number(r.refund);
      row.vaultTx = String(r.vaultTx);
    }
    perProvider.set(p, row);
  }
  const paid = payments.reduce((a, r) => a + Number(r.amount), 0);
  const refunded = refundsOf(mine).reduce((a, r) => a + Number(r.refund), 0);
  const fee = Number(job.attrs.fee ?? done?.fee ?? 0);
  // A job's payments and fee are all in one asset (HBAR or the HTS token); refunds are HBAR.
  const asset = payments[0]?.asset ?? done?.asset;
  const pay = (units: number) => amountOf(status, units, asset);
  const inHbar = !asset || asset === "0.0.0";
  const net = inHbar ? hbar(paid - refunded + fee + royalty) : `${pay(paid + fee)} · ${hbar(refunded)} back`;
  const pass = canaries.filter((c) => c.pass).length;
  const fail = canaries.length - pass;
  const rerouted = Number(job.attrs.rerouted ?? 0);
  const open = String(job.attrs.status) === "running";
  const admitted = quals.filter((q) => q.admitted).length;

  const TABS: [Tab, string, ReactNode?][] = [
    ["chunks", "Chunks", own.length || undefined],
    ["checks", "Checks", slashes.length ? <span className="bad">{slashes.length} slashed</span> : fail ? <span className="bad">{fail} failed</span> : canaries.length ? "✓" : undefined],
    ["payments", "Payments", payments.length || undefined],
    ["receipts", "Receipts", mine.length || undefined],
  ];

  const receiptRows = (rs: Receipt[], withTime = false) => (
    <div className="card">
      <ul className="rows">
        {rs.map((r) => (
          <li key={r.seq}>
            {withTime && <span className="when">{timeOf(r)}</span>}
            <span className="what">
              {withTime && <Tag tone={receiptTone(r)}>{receiptTag(r)}</Tag>}
              <ReceiptText r={r} status={status} label={label} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <div className="page pg">
      <a className="back link" href="#/jobs">
        ← Jobs
      </a>
      <div className="phead">
        <div style={{ minWidth: 0 }}>
          <h1 className="id">
            {jobId} <StatusTag status={String(job.attrs.status)} />
          </h1>
          <p>
            {String(job.attrs.task)}
            {model && (
              <>
                {" · "}
                <a className="link" href={`#/models/${model.key}`} title={`${model.name} · every chunk is signed for this model`}>
                  {model.listing?.card.name ?? model.name}
                </a>
              </>
            )}
            {startedMs ? ` · started ${when(startedMs)}` : ""}
          </p>
        </div>
      </div>

      <section className="kpis" aria-label="Job totals">
        <div className="kpi">
          <b>
            {Number(job.attrs.done)}/{Number(job.attrs.total)}
          </b>
          <span>Chunks final</span>
        </div>
        <div className="kpi">
          <b>{pay(paid)}</b>
          <span>Paid to providers</span>
        </div>
        <div className="kpi">
          <b className={refunded ? "bad" : ""}>{refunded ? `−${hbar(refunded)}` : "—"}</b>
          <span>Refunded</span>
        </div>
        <div className="kpi">
          <b>{inHbar ? net : pay(paid + fee)}</b>
          <span title={model && inHbar ? "Including the creator's royalty" : undefined}>{inHbar ? "Your net cost" : "You spent"}</span>
        </div>
      </section>

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
          {tab === "chunks" && (
            <>
              <h3 className="h3">
                Chunks <Tag>{`${own.length} sealed`}</Tag>
              </h3>
              <p className="note" title="Each chunk is sealed with its own key and travels only inside the paid request to its GPU. Hover a chunk for its state and provider.">
                {rerouted ? `${rerouted} chunk${rerouted === 1 ? "" : "s"} moved to another provider.` : "No chunk had to be rerouted."}
              </p>
              <ChunkGrid chunks={own} label={label} failed={canaryByIdx} />

              <h3 className="h3">
                Canary checks <Tag tone={fail ? "bad" : pass ? "ok" : "idle"}>{`${pass} pass · ${fail} fail`}</Tag>
              </h3>
              <p className="note" title="Hidden canaries re-run on 0G and compared with the provider.">
                Against 0G {status.zerog.model} · pass at {Math.round(status.policy.minAgreement * 100)}% · {canaries.length}/{own.length} scored · {reveal ? "revealed" : "committed"} on HCS
              </p>
              {canaries.length > 0 && (
                <>
                  <div className="files-wrap">
                    <table className="files">
                      <thead>
                        <tr>
                          <th>Chunk</th>
                          <th>Provider</th>
                          <th>Agreement</th>
                          <th title="0G's answer → the provider's">Where it differed</th>
                          <th className="hide-sm">0G request</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...canaries]
                          .reverse()
                          .sort((a, b) => Number(a.pass) - Number(b.pass))
                          .slice(0, showAll ? undefined : 6)
                          .map((c) => (
                            <tr key={`${c.idx}-${c.provider}`}>
                              <td className="mono">#{c.idx}</td>
                              <td>
                                <ProviderName addr={c.provider} label={label} />
                              </td>
                              <td>
                                <Meter value={c.agreement} threshold={status.policy.minAgreement} />
                              </td>
                              <td className="wrap">
                                <Diff expected={c.expected} actual={c.actual} />
                              </td>
                              <td className="mono small muted hide-sm" title={`${c.model} via ${c.zeroGProvider}`} style={{ whiteSpace: "normal", wordBreak: "break-all", minWidth: 180, maxWidth: 240 }}>
                                {c.requestId}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                  {canaries.length > 6 && (
                    <button className="link small" style={{ marginTop: 10 }} onClick={() => setShowAll(!showAll)}>
                      {showAll ? "Show fewer" : `Show all ${canaries.length} canaries`}
                    </button>
                  )}
                </>
              )}
            </>
          )}

          {tab === "checks" && (
            <>
              <h3 className="h3">
                Admission <Tag tone={quals.some((q) => !q.admitted) ? "warn" : quals.length ? "ok" : "idle"}>{quals.length ? `${admitted} admitted · ${quals.length - admitted} rejected` : "cached"}</Tag>
              </h3>
              {quals.length === 0 ? <p className="note">Admitted in the last 30 minutes. No new probe needed.</p> : receiptRows(quals)}

              <h3 className="h3">
                Enforcement{" "}
                <Tag tone={slashes.length ? "bad" : malformed.length ? "warn" : "idle"}>{slashes.length ? `${slashes.length} slashed · ${hbar(refunded)} back` : malformed.length ? `${malformed.length} malformed` : "no slash"}</Tag>
              </h3>
              {[...slashes, ...malformed].length === 0 ? (
                <p className="note">
                  Slashing needs {status.policy.failLimit} of {status.policy.window} failed checks. None reached it.
                </p>
              ) : (
                receiptRows([...slashes, ...settles, ...malformed])
              )}

              <h3 className="h3">
                Where it ran <ExecutionTag runs={runs} />
              </h3>
              {runs.length === 0 ? (
                <p className="note">No chunk carried a 0G Compute execution record.</p>
              ) : (
                <div className="files-wrap">
                  <table className="files">
                    <thead>
                      <tr>
                        <th className="num">Chunk</th>
                        <th>Provider</th>
                        <th>0G provider</th>
                        <th className="hide-sm">Model</th>
                        <th className="hide-sm">Response</th>
                        <th>Attestation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map((r) => (
                        <tr key={`${r.idx}-${r.provider}-${r.chat}`}>
                          <td className="num">#{String(r.idx)}</td>
                          <td>
                            <ProviderName addr={String(r.provider)} label={label} />
                          </td>
                          <td>
                            <span className="mono" title={String(r.zg)}>
                              {short(String(r.zg))}
                            </span>
                            {r.pt === "centralized" && <span className="sub warn">relays to {String(r.pid ?? "an outside cloud")}, not a 0G node</span>}
                          </td>
                          <td className="mono small hide-sm">{String(r.m ?? "—")}</td>
                          <td className="hide-sm">
                            <span className="mono" title={String(r.chat)}>
                              {short(String(r.chat), 10)}
                            </span>
                          </td>
                          <td>
                            <AttestationTag att={r.att as string | undefined} />
                            {r.why ? <span className="sub">{String(r.why)}</span> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <h3 className="h3">
                Canary references <CanaryTeeTag canaries={canaries} />
              </h3>
              {canaries.every((c) => !c.tee) ? (
                <p className="note">{canaries.length ? "No TEE signature check on these canaries (scored before it was recorded)." : "No canary has been scored yet."}</p>
              ) : (
                <>
                  <p className="note" title="Fetched from the 0G provider and recovered against the TEE signer in 0G's serving contract.">
                    Each 0G reference run uses TeeML. The verifier checks its TEE signature against 0G's registered signer.
                  </p>
                  <div className="files-wrap">
                    <table className="files">
                      <thead>
                        <tr>
                          <th className="num">Chunk</th>
                          <th>0G provider</th>
                          <th className="hide-sm">Trust mode</th>
                          <th className="hide-sm">Signed</th>
                          <th>TEE signature</th>
                        </tr>
                      </thead>
                      <tbody>
                        {canaries
                          .filter((c) => c.tee)
                          .sort((a, b) => a.idx - b.idx)
                          .map(({ idx, provider, tee }) => (
                            <tr key={`${idx}-${provider}`}>
                              <td className="num">#{idx}</td>
                              <td>
                                <span className="mono" title={tee!.provider}>
                                  {short(tee!.provider)}
                                </span>
                                <span className={tee!.guarantee === "TeeML" ? "sub" : "sub warn"}>
                                  {tee!.guarantee === "TeeML" ? "TeeML: the model ran in the enclave" : tee!.guarantee === "TeeTLS" ? `relays to ${tee!.providerIdentity ?? "an outside cloud"}, not a 0G node` : "TEE type unknown"}
                                </span>
                              </td>
                              <td className="hide-sm">
                                {tee!.trustMode}
                                {tee!.fallback ? <span className="sub warn">{tee!.fallback}</span> : null}
                              </td>
                              <td className="hide-sm">
                                <span className="mono" title={`${tee!.signedText ?? ""}\nchat ${tee!.chatId}\nsigner ${tee!.signer ?? "—"}`}>
                                  {tee!.signedTextHash ? short(tee!.signedTextHash, 10) : "—"}
                                </span>
                                {tee!.scheme ? <span className="sub">{tee!.scheme === "zg-sig-v1/e2ee-ct" ? "sealed exchange" : tee!.scheme}</span> : null}
                              </td>
                              <td>
                                {tee!.verification === "verified" ? <Tag tone="ok">TEE signature verified</Tag> : <AttestationTag att={tee!.verification} />}
                                {tee!.reason ? <span className="sub">{tee!.reason}</span> : null}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}

          {tab === "payments" && (
            <>
              <h3 className="h3">
                Per provider <Tag tone={paid ? "ok" : "idle"}>{`${payments.length} x402 payments`}</Tag>
              </h3>
              <div className="files-wrap">
                <table className="files">
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th className="num">Chunks</th>
                      <th className="num">Paid</th>
                      <th className="num">Refunded</th>
                      <th className="hide-sm">First payment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...perProvider].map(([addr, r]) => (
                      <tr key={addr}>
                        <td>
                          <ProviderName addr={addr} label={label} />
                        </td>
                        <td className="num">{r.chunks}</td>
                        <td className="num">{pay(r.paid)}</td>
                        <td className="num">{r.refund ? <span className="bad">{hbar(r.refund)}</span> : "—"}</td>
                        <td className="hide-sm">{r.payTx ? <TxLink status={status} id={r.payTx} /> : "—"}</td>
                      </tr>
                    ))}
                    {perProvider.size === 0 && (
                      <tr>
                        <td colSpan={5} className="muted">
                          No payments yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {model && (
                <>
                  <h3 className="h3">
                    Creator royalty <Tag tone={royalty ? "ok" : open ? "warn" : "idle"}>{royalty ? `${hbar(royalty)} paid` : open ? "after the job" : "none owed"}</Tag>
                  </h3>
                  {royaltyReceipt ? (
                    <div className="card card-body">
                      <ul className="side-list">
                        <li>
                          <span className="muted">Paid</span>
                          <b className="ok">{hbar(royalty)}</b>
                        </li>
                        <li>
                          <span className="muted">Basis</span>
                          <span className="v">
                            {hbar(Number(royaltyReceipt.basis))} for {Number(royaltyReceipt.chunks)} accepted chunks
                          </span>
                        </li>
                        <li>
                          <span className="muted">To</span>
                          <span className="mono v">{String(royaltyReceipt.payTo)}</span>
                        </li>
                        <li>
                          <span className="muted">Transaction</span>
                          <TxLink status={status} id={String(royaltyReceipt.tx)} />
                        </li>
                      </ul>
                      <p className="hint">Never paid on refunded, rerouted or failed chunks.</p>
                    </div>
                  ) : (
                    <p className="note" title="The passport is co-signed only after the royalty is paid.">
                      Paid over x402 when the job closes, on accepted chunks only.
                    </p>
                  )}
                </>
              )}
            </>
          )}

          {tab === "receipts" && (mine.length === 0 ? <div className="empty-hub">No receipts for this job yet.</div> : receiptRows(mine, true))}
        </div>

        <aside className="side">
          <div className="side-card">
            <h4>
              Settlement
              <Tag tone={open ? "warn" : "ok"} live={open}>
                {open ? "open" : "closed"}
              </Tag>
            </h4>
            <ul className="side-list">
              <li>
                <span className="muted">Paid</span>
                <span>{pay(paid)}</span>
              </li>
              <li>
                <span className="muted">Refunded</span>
                {refunded ? <span className="bad">−{hbar(refunded)}</span> : <span>—</span>}
              </li>
              <li>
                <span className="muted">Verifier fee</span>
                <span>{pay(fee)}</span>
              </li>
              {model && (
                <li>
                  <span className="muted">Creator royalty</span>
                  <span>{royalty ? hbar(royalty) : "—"}</span>
                </li>
              )}
              <li className="total">
                <span>Net cost</span>
                <span className="v">{net}</span>
              </li>
            </ul>
          </div>

          {model && (
            <div className="side-card">
              <h4>Model</h4>
              <ul className="side-list">
                <li>
                  <a className="link" href={`#/models/${model.key}`}>
                    {model.listing?.card.name ?? model.name}
                  </a>
                </li>
                <li>
                  <span className="mono small muted v" style={{ textAlign: "left" }}>
                    {model.name}
                  </span>
                </li>
                <li>
                  <span className="muted">Creator royalty</span>
                  <span>{model.listing ? `${model.listing.card.royaltyBps / 100}%` : "agreed before work"}</span>
                </li>
              </ul>
            </div>
          )}

          <div className="side-card">
            <h4>Proof</h4>
            <ul className="side-list">
              <li>
                <span className="muted">HCS topic</span>
                <TxLink status={status} kind="topic" id={status.hcsTopic} text={status.hcsTopic} />
              </li>
              <li>
                <span className="muted">Commitment</span>
                {registered ? (
                  <span className="mono" title={String(registered.commitment)}>
                    {short(String(registered.commitment), 6)}
                  </span>
                ) : (
                  <span>—</span>
                )}
              </li>
              <li>
                <span className="muted">Canary chunks</span>
                {reveal ? <span className="mono v">{(reveal.canaries as number[]).map((i) => `#${i}`).join(", ") || "none"}</span> : <span className="muted">revealed at close</span>}
              </li>
              <li>
                <span className="muted">Merkle anchor</span>
                {anchor ? (
                  <span className="mono" title={`hcs.merkleRootAnchor over ${Number(anchor.recordCount)} chunks: ${String(anchor.merkleRoot)}`}>
                    {short(String(anchor.merkleRoot), 6)} · {Number(anchor.recordCount)} chunks
                  </span>
                ) : (
                  <span className="muted">anchored at close</span>
                )}
              </li>
              {spot ? (
                <li>
                  <span className="muted">PRNG spot checks</span>
                  <span className="mono" title={`Hedera PRNG seed ${String(spot.seed)}, drawn after the reveal`}>
                    {(spot.picks as number[]).join(", ") || "none"} · {spotChecked.filter((c) => c.pass).length}/{spotChecked.filter((c) => c.pass !== undefined).length} agreed
                  </span>
                </li>
              ) : null}
              <li>
                <span className="muted">Compute Passport</span>
                {storageLink(status, String(job.attrs.audit_ref ?? "")) ? (
                  <a className="ext mono" href={storageLink(status, String(job.attrs.audit_ref))!} target="_blank" rel="noreferrer" title={`On 0G Storage: ${String(job.attrs.audit_ref)}`}>
                    {short(String(job.attrs.audit_ref), 6)}
                  </a>
                ) : job.attrs.audit_ref ? (
                  <span className="mono muted" title="Stored before passports moved to 0G Storage: this reference can't be opened here">
                    {short(String(job.attrs.audit_ref), 6)}
                  </span>
                ) : (
                  <span className="muted">stored at close</span>
                )}
              </li>
            </ul>
            {isStorageRef(String(job.attrs.audit_ref ?? "")) ? (
              <details className="more">
                <summary>Verify the passport yourself</summary>
                <pre className="cmd">{`npm run passport:verify -- ${String(job.attrs.audit_ref)}`}</pre>
              </details>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}

/** The verifier's attestation verdict, in its own words: unavailable is never shown as verified. */
function CanaryTeeTag({ canaries }: { canaries: CanaryResult[] }) {
  const tees = canaries.flatMap((c) => (c.tee ? [c.tee] : []));
  if (tees.length === 0) return <Tag>not recorded</Tag>;
  const verified = tees.filter((t) => t.verification === "verified").length;
  const invalid = tees.filter((t) => t.verification === "invalid").length;
  const outside = tees.filter((t) => t.trustMode !== "private" || t.guarantee !== "TeeML").length;
  const tone = invalid ? "bad" : verified < tees.length || outside ? "warn" : "ok";
  return <Tag tone={tone}>{`${verified}/${tees.length} TEE signature${tees.length === 1 ? "" : "s"} verified${outside ? ` · ${outside} outside TeeML` : ""}`}</Tag>;
}

function AttestationTag({ att }: { att?: string }) {
  if (att === "verified") return <Tag tone="ok">verified</Tag>;
  if (att === "invalid") return <Tag tone="bad">invalid</Tag>;
  return <Tag tone="warn">unavailable</Tag>;
}

function ExecutionTag({ runs }: { runs: Receipt[] }) {
  if (runs.length === 0) return <Tag>not recorded</Tag>;
  const n = (a: string) => runs.filter((r) => (r.att ?? "unavailable") === a).length;
  const upstreams = new Set(runs.map((r) => r.zg)).size;
  const tone = n("invalid") ? "bad" : n("unavailable") ? "warn" : "ok";
  return <Tag tone={tone}>{`${upstreams} 0G provider${upstreams === 1 ? "" : "s"} · ${n("verified")} verified · ${n("unavailable")} unavailable · ${n("invalid")} invalid`}</Tag>;
}
