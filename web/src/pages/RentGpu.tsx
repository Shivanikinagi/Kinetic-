import { hbar, listingsOf, money } from "../data";
import type { Snapshot } from "../live";

// How to rent out a GPU: bond HBAR, offer a price, serve verified models and get paid per chunk.
// A guide; the node itself runs from the CLI, with the provider's own key.

export default function RentGpu({ snap }: { snap: Snapshot }) {
  return (
    <div className="page pg">
      <div className="phead pg-bar">
        <h1 className="sr-only">Rent out a GPU</h1>
        <span className="small muted">
          {snap.offers.length} GPUs live · {listingsOf(snap.status, snap.models).length} models to serve
        </span>
        <a className="btn" href="#/providers">
          All GPUs
        </a>
      </div>
      <Provide snap={snap} />
    </div>
  );
}

function Provide({ snap }: { snap: Snapshot }) {
  const { status, offers } = snap;
  const prices = offers.map((o) => Number(o.attrs.price));
  const bonds = offers.map((o) => Number(o.attrs.bond));
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const models = listingsOf(status, snap.models);
  return (
    <div className="mlayout">
      <div className="card" style={{ minWidth: 0 }}>
        <section className="fsec">
          <div className="fsec-head">
            <h3>Start a node</h3>
          </div>
          <pre className="cmd">{`npm run kinetic -- init provider     # key, Hedera account, Arkiv gas
# then in .kinetic/provider.env:
PROVIDER_NAME=my-4090
PROVIDER_GPU="RTX 4090"
PROVIDER_PUBLIC_URL=https://…        # reachable by buyers
PROVIDER_PRICE_TINYBAR=100000
PROVIDER_MODELS=${models[0]?.card.id ?? "kinetic/ticket-classifier"}
PROVIDER_SANDBOX=docker:no-network   # see docker/ollama-sandbox.compose.yml
npm run kinetic -- provider`}</pre>
        </section>
        <section className="fsec">
          <div className="fsec-head">
            <h3>Good to know</h3>
          </div>
          <ul className="checks">
            <li>
              <span className="ico" aria-hidden>
                ✓
              </span>
              <span>
                Models are checked before they load
                <span className="d">Its passport, every weights file's sha256 and the malware checks.</span>
              </span>
            </li>
            <li>
              <span className="ico" aria-hidden>
                ✓
              </span>
              <span>
                Sandboxed runtime
                <span className="d">docker/ollama-sandbox.compose.yml gives the model no route to the internet.</span>
              </span>
            </li>
            <li>
              <span className="ico" aria-hidden>
                ✓
              </span>
              <span>
                Buyers' data stays private
                <span className="d">Chunks arrive encrypted from Swarm.</span>
              </span>
            </li>
            <li className="bad">
              <span className="ico" aria-hidden>
                !
              </span>
              <span>
                Slashing is permanent for that address
                <span className="d">
                  {status.policy.failLimit} of {status.policy.window} failed checks. Withdrawals wait a delay so a slash can still land.
                </span>
              </span>
            </li>
          </ul>
        </section>
      </div>

      <aside className="side">
        <div className="side-card">
          <div className="side-stats">
            <div>
              <b>{bonds.length ? hbar(avg(bonds)) : "—"}</b>
              <span>Typical bond</span>
            </div>
            <div>
              <b>{prices.length ? money(status, avg(prices)) : "—"}</b>
              <span>Average price / chunk</span>
            </div>
            <div>
              <b>{models.length}</b>
              <span>Models to serve</span>
            </div>
            <div>
              <b>{Math.round(status.policy.minAgreement * 100)}%</b>
              <span>Pass mark</span>
            </div>
          </div>
        </div>
        <div className="side-card">
          <h4>How it works</h4>
          <ol className="flow">
            <li>
              Bond
              <span>Locked in the Hedera vault</span>
            </li>
            <li>
              Choose models
              <span>Checked against their passports</span>
            </li>
            <li>
              Offer
              <span>Your price, published on Arkiv</span>
            </li>
            <li>
              Admission
              <span>Known-answer probe and model fingerprint</span>
            </li>
            <li>
              Work
              <span>Paid per chunk over x402</span>
            </li>
            <li>
              Checks
              <span>Known answers and hidden canaries vs 0G</span>
            </li>
          </ol>
        </div>
      </aside>
    </div>
  );
}
