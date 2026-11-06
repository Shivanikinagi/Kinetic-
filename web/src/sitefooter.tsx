import { REPLAY } from "./data";
import type { Snapshot } from "./live";

/** The website footer (landing and Models): link columns, then the live network line. */
export function SiteFooter({ snap }: { snap: Snapshot | null }) {
  return (
    <footer className="ak-footer">
      <div className="ak-footer-top">
        <div className="ak-footer-brand">
          <a className="brand" href="#/" aria-label="KINETIC home">
            <span className="brand-mark" aria-hidden />
            <span className="brand-word">KINETIC</span>
          </a>
          <p>Verified AI on community GPUs.</p>
        </div>
        <nav aria-label="Product">
          <h4>Product</h4>
          <a href="#/models">Models</a>
          <a href="#/console">Console</a>
        </nav>
        <nav aria-label="Console">
          <h4>Console</h4>
          <a href="#/run">Run a job</a>
          <a href="#/jobs">Jobs</a>
          <a href="#/providers">GPUs</a>
          <a href="#/publish">Publish</a>
          <a href="#/creators">Creators</a>
        </nav>
        <nav aria-label="Learn">
          <h4>Learn</h4>
          <a href="#/docs">Docs</a>
          <a href="#/audit">Audit trail</a>
        </nav>
      </div>
      <div className="ak-footer-bottom">
        <span>© {new Date().getFullYear()} KINETIC</span>
        <span>
          {snap ? (
            <>
              <span className="ak-live" aria-hidden />
              {REPLAY ? "Synthetic replay" : `Hedera ${snap.status.network}`} · 0G · Arkiv · Swarm · Updated {new Date(snap.at).toLocaleTimeString()}
            </>
          ) : (
            "Hedera · 0G · Arkiv · Swarm"
          )}
        </span>
      </div>
    </footer>
  );
}
