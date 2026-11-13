// The network as a ring: the verifier in the middle, the GPU providers around it, each coloured by
// its real state (live, busy, slashed, rejected, offline) from the live snapshot. Every figure in the
// stats box comes from that snapshot too; with no snapshot yet it says so instead of inventing numbers.
// `stage` highlights one of the six trust stages, for the landing page's walkthrough.
import { useMemo } from "react";
import { REPLAY, hbar, writtenBy } from "./data";
import { useLive, type Snapshot } from "./live";

export type NodeState = "live" | "busy" | "slashed" | "rejected" | "offline";

export interface RingNode {
  addr: string;
  name: string;
  state: NodeState;
  price?: number;
  bond?: number;
  adversarial?: string;
}

const MAX_NODES = 10;
/** Past providers (slashed, rejected, offline) shown at most, so old rotated keys don't crowd out the live ones. */
const MAX_INACTIVE = 5;

/** Every provider the network knows about (an offer, a reputation, or both), with its state. */
export function ringNodes(snap: Snapshot, label: (a: string) => string): RingNode[] {
  const addrs = [...new Set([...snap.offers.map((o) => String(o.attrs.provider)), ...snap.reputations.map((r) => String(r.attrs.provider))])];
  const nodes = addrs.map((addr): RingNode => {
    const offer = snap.offers.find((o) => o.attrs.provider === addr && writtenBy(o, addr));
    const rep = snap.reputations.find((r) => r.attrs.provider === addr && writtenBy(r, snap.status.verifier));
    const busy = snap.claims.some((c) => c.attrs.provider === addr);
    const state: NodeState = rep?.attrs.status === "slashed" ? "slashed" : rep?.attrs.qual_status === "rejected" ? "rejected" : !offer ? "offline" : busy ? "busy" : "live";
    return {
      addr,
      name: label(addr),
      state,
      ...(offer?.attrs.price !== undefined ? { price: Number(offer.attrs.price) } : {}),
      ...(offer?.attrs.bond !== undefined ? { bond: Number(offer.attrs.bond) } : {}),
      ...((offer?.attrs.adversarial ?? rep?.attrs.adversarial) ? { adversarial: String(offer?.attrs.adversarial ?? rep?.attrs.adversarial) } : {}),
    };
  });
  // Live ones first, so a crowded network still shows who can take work. A provider that rotated its
  // key after a slash leaves its old address behind under the same name: show each inactive name once.
  const order: Record<NodeState, number> = { busy: 0, rejected: 1, live: 1, slashed: 2, offline: 3 };
  const active = nodes.filter((n) => n.state === "live" || n.state === "busy" || n.state === "rejected");
  const seen = new Set(active.map((n) => n.name));
  const inactive = nodes.filter((n) => !active.includes(n)).filter((n) => !seen.has(n.name) && (seen.add(n.name), true)).slice(0, MAX_INACTIVE);
  return [...active, ...inactive].sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name)).slice(0, MAX_NODES);
}

export function ringStats(snap: Snapshot, nodes: RingNode[]) {
  const checks = snap.receipts.filter((r) => r.t === "canary" || r.t === "known");
  return {
    live: nodes.filter((n) => n.state === "live" || n.state === "busy").length,
    busy: nodes.filter((n) => n.state === "busy").length,
    bonded: nodes.filter((n) => n.state === "live" || n.state === "busy").reduce((a, n) => a + (n.bond ?? 0), 0),
    checks: checks.length,
    failed: checks.filter((r) => !r.pass).length,
    slashes: snap.receipts.filter((r) => r.t === "slash").length,
    paid: snap.receipts.filter((r) => r.t === "chunk").length,
  };
}

const STATE_TEXT: Record<NodeState, string> = { live: "live", busy: "working", slashed: "slashed", rejected: "rejected", offline: "offline" };

const SIZE = 420;
const C = SIZE / 2;
const R = 150;

export function NetworkRing({ stage, showStats = true, className = "" }: { stage?: number; showStats?: boolean; className?: string }) {
  const { snap, label } = useLive();
  const nodes = useMemo(() => (snap ? ringNodes(snap, label) : []), [snap, label]);
  const stats = snap ? ringStats(snap, nodes) : null;
  const pos = (i: number) => {
    const a = -Math.PI / 2 + (i / Math.max(nodes.length, 1)) * Math.PI * 2;
    return { x: C + R * Math.cos(a), y: C + R * Math.sin(a) };
  };

  return (
    <div className={`ring ${stage !== undefined ? `stage-${stage}` : ""} ${className}`}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={snap ? `Network: ${stats!.live} GPUs live around the verifier` : "Connecting to the network"}>
        <circle cx={C} cy={C} r={R} className="ring-orbit" />
        {nodes.map((n, i) => {
          const p = pos(i);
          return (
            <g key={n.addr} className={`ring-link ${n.state}`}>
              <line x1={C} y1={C} x2={p.x} y2={p.y} />
              {(n.state === "busy" || n.state === "live") && (
                <circle r={3} className="ring-chunk">
                  <animateMotion dur={n.state === "busy" ? "1.6s" : "3.2s"} repeatCount="indefinite" path={`M ${p.x} ${p.y} L ${C} ${C}`} />
                </circle>
              )}
            </g>
          );
        })}
        <g className="ring-center">
          <circle cx={C} cy={C} r={46} className="ring-core-halo" />
          <circle cx={C} cy={C} r={38} className="ring-core" />
          <text x={C} y={C - 4} textAnchor="middle" className="ring-core-t">
            Verifier
          </text>
          <text x={C} y={C + 12} textAnchor="middle" className="ring-core-s">
            {snap ? `quorum ${snap.status.quorum?.threshold ?? 1}/${snap.status.quorum?.verifiers.length ?? 1}` : "connecting…"}
          </text>
        </g>
        <g className="ring-ledger">
          <rect x={C - 58} y={C + 62} width={116} height={22} rx={11} />
          <text x={C} y={C + 77} textAnchor="middle">
            HCS {snap?.status.hcsTopic ?? "receipts"}
          </text>
        </g>
        {nodes.map((n, i) => {
          const p = pos(i);
          return (
            <g key={n.addr} className={`ring-node ${n.state}`} transform={`translate(${p.x} ${p.y})`}>
              <title>{`${n.name}: ${STATE_TEXT[n.state]}${n.adversarial ? ` (test provider: ${n.adversarial})` : ""}`}</title>
              <rect x={-54} y={-17} width={108} height={34} rx={6} />
              <text y={-2} textAnchor="middle" className="ring-node-t">
                {n.name.length > 14 ? `${n.name.slice(0, 13)}…` : n.name}
              </text>
              <text y={11} textAnchor="middle" className="ring-node-s">
                {STATE_TEXT[n.state]}
                {n.price !== undefined && n.state !== "offline" ? ` · ${hbar(n.price)}` : ""}
              </text>
            </g>
          );
        })}
      </svg>

      {showStats && (
        <dl className="ring-stats" aria-label="Network totals">
          {stats ? (
            <>
              <div>
                <dt>GPUs live</dt>
                <dd>
                  {stats.live}
                  {stats.busy ? <small>{stats.busy} working</small> : null}
                </dd>
              </div>
              <div>
                <dt>Bonded</dt>
                <dd>{hbar(stats.bonded)}</dd>
              </div>
              <div>
                <dt>Chunks paid</dt>
                <dd>{stats.paid}</dd>
              </div>
              <div>
                <dt>Checks</dt>
                <dd>
                  {stats.checks}
                  {stats.failed ? <small className="bad">{stats.failed} failed</small> : null}
                </dd>
              </div>
              <div>
                <dt>Slashes</dt>
                <dd className={stats.slashes ? "bad" : ""}>{stats.slashes}</dd>
              </div>
            </>
          ) : (
            <p className="ring-wait">Waiting for the network. Figures appear once the verifier answers.</p>
          )}
          {REPLAY && stats && <p className="ring-wait">Synthetic replay: not live figures.</p>}
        </dl>
      )}

      <ul className="ring-legend" aria-label="Legend">
        {(["live", "busy", "slashed", "rejected", "offline"] as NodeState[]).map((s) => (
          <li key={s} className={s}>
            <span aria-hidden />
            {STATE_TEXT[s]}
          </li>
        ))}
      </ul>
    </div>
  );
}
