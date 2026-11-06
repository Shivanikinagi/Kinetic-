import { useState } from "react";

// Get started: the four things people do on KINETIC, each as commands that work as written.

function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code">
      <pre>{children}</pre>
      <button
        className="copy"
        onClick={() => {
          void navigator.clipboard?.writeText(children);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

const STEPS: { n: number; title: string; text: string; code: string; sdk?: string }[] = [
  {
    n: 1,
    title: "Get a testnet account",
    text: "One command creates your key, testnet account and Arkiv gas.",
    code: "npm install\nnpm run kinetic -- init buyer",
  },
  {
    n: 2,
    title: "Run a verified model",
    text: "Pay per chunk in HBAR. GPUs that fail hidden checks are slashed, and you're refunded.",
    code: "npm run kinetic -- run --model kinetic/review-sentiment --items reviews.jsonl",
    sdk: `import { Kinetic } from "./src/sdk/index.js";

const kinetic = Kinetic.fromEnv();
const report = await kinetic.run({
  model: "kinetic/review-sentiment",
  items: ["Love it, works perfectly", "Broke after two days"],
  budget: "0.5 HBAR",
});
console.log(report.results, report.passport);`,
  },
  {
    n: 3,
    title: "Publish a model and earn",
    text: "Safetensors weights. Three verifiers scan, benchmark and sign its passport. Earn on every accepted chunk.",
    code: "npm run kinetic -- models publish --card my-model.card.json --weights ./my-model/ --storage 0g",
    sdk: `await kinetic.publish({
  card,                                   // id, version, task, runtime, royaltyBps
  files: [{ name: "model.safetensors", path: "./my-model/model.safetensors" }],
  storage: "0g",                          // multi-GB weights on 0G Storage
});`,
  },
  {
    n: 4,
    title: "Rent out a GPU",
    text: "Bond HBAR, serve verified models, get paid per chunk. Cheating costs the bond.",
    code: "npm run kinetic -- init provider\nPROVIDER_MODELS=kinetic/review-sentiment npm run kinetic -- provider",
  },
];

const API: [string, string, string][] = [
  ["GET", "/models", "every listed model with its passport digest"],
  ["GET", "/models/:key/passport", "a Model Passport, from Swarm"],
  ["POST", "/models", "publish a card (x402 listing fee)"],
  ["POST", "/jobs", "register a job (x402 verification fee)"],
  ["GET", "/models/reviews/:key", "a model's review, step by step"],
  ["GET", "/jobs/:id/canaries", "a job's hidden checks, revealed after it closes"],
  ["POST", "/jobs/:id/royalty", "pay a model's creator (x402)"],
  ["GET", "/status", "network, quorum, policy and 0G usage"],
];

export default function Docs() {
  return (
    <div className="page pg">
      <div className="pg-head pg-bar">
        <h1 className="sr-only">Get started</h1>
        <a className="btn" href="#/audit">
          See the audit trail
        </a>
      </div>

      <div className="doc-steps">
        {STEPS.map((s) => (
          <section key={s.n} className="doc-step">
            <span className="n">Step {s.n}</span>
            <h3>{s.title}</h3>
            <p className="muted">{s.text}</p>
            <Code>{s.code}</Code>
            {s.sdk && (
              <details className="more">
                <summary>From your code</summary>
                <Code>{s.sdk}</Code>
              </details>
            )}
          </section>
        ))}
      </div>

      <div className="h2row">
        <h2>Verifier API</h2>
        <span className="muted small">paid endpoints use x402 on Hedera</span>
      </div>
      <div className="files-wrap">
        <table className="files">
          <tbody>
            {API.map(([m, p, d]) => (
              <tr key={p + m}>
                <td>
                  <span className={`tag ${m === "POST" ? "warn" : "ok"}`}>{m}</span>
                </td>
                <td className="mono">{p}</td>
                <td className="muted">{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
