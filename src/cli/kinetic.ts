import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { formatEther, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadJob, printReport, writeReport } from "../agent/report.js";
import { identityFromEnv, loadNetworkConfig } from "../config.js";
import { ArkivSdkStore, attrBig, attrStr } from "../integrations/arkiv.js";
import { connect } from "../integrations/index.js";
import { EvmBondVault } from "../integrations/vault.js";
import { TESTNET } from "../networks.js";
import { DEFAULT_0G_WORKER_MODEL } from "../provider/backend.js";
import { startProvider } from "../provider/node.js";
import { providerOptionsFromEnv } from "../provider/options.js";
import { builtInTasks, Kinetic, toTinybar } from "../sdk/index.js";
import { formatHbar, type Item } from "../types.js";
import type { PublishInput } from "../models/publish.js";
import {
  ARKIV_FAUCET,
  arkivBalance,
  completeHollowAccount,
  createAccount,
  detectGpu,
  detectModels,
  fundArkiv,
  HEDERA_FAUCET,
  mirrorAccount,
  readEnvFile,
  waitFor,
  writeEnvFile,
} from "./setup.js";

// One command for everyone who uses KINETIC: `npm run kinetic -- <command>`.
//
//   init [buyer|provider]   create your key, Hedera account and Arkiv gas, and write your settings
//   status [buyer|provider] what the networks say about you (read-only)
//   run --task <name>       run a paid, verified job as a buyer
//   provider                start your provider node
//   tasks                   the built-in tasks
//
// Settings live in .kinetic/buyer.env or .kinetic/provider.env (git-ignored: they hold your key).
// This command never reads the repository's .env.

type Role = "buyer" | "provider";

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    env: { type: "string" },
    yes: { type: "boolean", short: "y", default: false },
    "no-wait": { type: "boolean", default: false },
    "operator-id": { type: "string" },
    "operator-key": { type: "string" },
    "arkiv-funder-key": { type: "string" },
    "arkiv-api-key": { type: "string" },
    verifier: { type: "string" },
    topic: { type: "string" },
    vault: { type: "string" },
    name: { type: "string" },
    port: { type: "string" },
    "public-url": { type: "string" },
    gpu: { type: "string" },
    backend: { type: "string" },
    model: { type: "string" },
    "model-url": { type: "string" },
    "zerog-key": { type: "string" },
    price: { type: "string" },
    bond: { type: "string" },
    task: { type: "string" },
    items: { type: "string" },
    chunk: { type: "string" },
    "max-price": { type: "string" },
    "max-spend": { type: "string" },
    card: { type: "string" },
    weights: { type: "string" },
    benchmark: { type: "string" },
    storage: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [command, arg] = positionals;
const MIN_HBAR: Record<Role, bigint> = { buyer: 200_000_000n, provider: 200_000_000n };
// About 0.0003 per Arkiv write; buyers write far more (jobs, chunks, claims) than providers.
const MIN_ARKIV: Record<Role, bigint> = { buyer: parseEther("0.05"), provider: parseEther("0.01") };
const WAIT_MS = 15 * 60_000;

const envPath = (role: Role) => flags.env ?? `.kinetic/${role}.env`;
const parseRole = (value: string | undefined, fallback: Role): Role => {
  if (value === undefined) return fallback;
  if (value !== "buyer" && value !== "provider") throw new Error(`role must be buyer or provider, got ${value}`);
  return value;
};

function loadRole(role: Role): Record<string, string | undefined> {
  const file = readEnvFile(envPath(role));
  if (!file) throw new Error(`${envPath(role)} not found: run \`npm run kinetic -- init ${role}\` first`);
  return { ...process.env, ...file };
}

const interactive = () => process.stdin.isTTY && !flags.yes;

async function ask(question: string, fallback: string): Promise<string> {
  if (!interactive()) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`  ${question}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback;
  } finally {
    rl.close();
  }
}

const step = (msg: string) => console.log(`\n▸ ${msg}`);
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const warn = (msg: string) => console.log(`  ! ${msg}`);

// ── init ─────────────────────────────────────────────────────────────────────

async function init(role: Role): Promise<void> {
  const path = envPath(role);
  const saved = readEnvFile(path) ?? {};
  const cfg = loadNetworkConfig({ ...saved, KINETIC_NETWORK: "testnet" });
  const header = `# Written by \`npm run kinetic -- init ${role}\`. Holds your private key: never share or commit it.`;
  const settings: Record<string, string | undefined> = { KINETIC_NETWORK: "testnet", ...saved };
  const save = () => writeEnvFile(path, header, settings);

  console.log(`KINETIC setup for a ${role}. Everything is on testnets: no real money.`);

  // 1. Key. Saved before anything else, so the address you fund is never lost.
  step("Your key");
  settings.KINETIC_PRIVATE_KEY ??= generatePrivateKey();
  const address = privateKeyToAccount(settings.KINETIC_PRIVATE_KEY as Hex).address.toLowerCase();
  save();
  ok(`${saved.KINETIC_PRIVATE_KEY ? "using" : "created"} the key in ${path}`);
  ok(`your address ${address} (your Hedera account, Arkiv wallet and ${role === "buyer" ? "refund address" : "bond holder"})`);

  // 2. Hedera account.
  step("Hedera testnet account");
  let account = await mirrorAccount(cfg.hedera.mirrorUrl, settings.HEDERA_ACCOUNT_ID || address);
  if (account?.evmAddress && account.evmAddress !== address) throw new Error(`${account.id} belongs to a different key (${account.evmAddress}); remove HEDERA_ACCOUNT_ID from ${path}`);
  const operatorId = flags["operator-id"] ?? process.env.OPERATOR_ID;
  const operatorKey = flags["operator-key"] ?? process.env.OPERATOR_KEY;
  if (!account && operatorId && operatorKey) {
    const id = await createAccount(operatorId, operatorKey, settings.KINETIC_PRIVATE_KEY as Hex, 10);
    ok(`created ${id} with 10 ℏ from ${operatorId}`);
    account = await waitFor(() => mirrorAccount(cfg.hedera.mirrorUrl, id), 60_000, 2000);
  }
  if (!account) {
    console.log(`  Get free testnet HBAR: open ${HEDERA_FAUCET}, paste your address and request HBAR:\n\n      ${address}\n`);
    console.log("  The faucet creates your account. (Or re-run with --operator-id/--operator-key to fund it from an account you have.)");
    if (flags["no-wait"]) return void console.log(`\n  Re-run \`npm run kinetic -- init ${role}\` once it's funded.`);
    console.log("  Waiting for it to appear (up to 15 min; Ctrl-C and re-run any time, your key is saved)…");
    account = await waitFor(() => mirrorAccount(cfg.hedera.mirrorUrl, address), WAIT_MS);
    if (!account) throw new Error(`no account for ${address} yet; re-run init once the faucet has funded it`);
  }
  if (account.hollow) {
    await completeHollowAccount(account.id, settings.KINETIC_PRIVATE_KEY as Hex);
    ok(`activated ${account.id} (the faucet creates accounts without a key; it now has yours)`);
  }
  settings.HEDERA_ACCOUNT_ID = account.id;
  save();
  ok(`${account.id} holds ${formatHbar(account.balanceTinybar)}`);
  if (account.balanceTinybar < MIN_HBAR[role]) warn(`a ${role} needs at least ${formatHbar(MIN_HBAR[role])}: top up at ${HEDERA_FAUCET}`);

  // 3. Arkiv gas, for publishing offers (providers) or jobs and chunk claims (buyers).
  step("Arkiv gas");
  let gas = await arkivBalance(cfg.arkiv, address);
  const funder = flags["arkiv-funder-key"] as Hex | undefined;
  if (gas < MIN_ARKIV[role] && funder) {
    const tx = await fundArkiv(cfg.arkiv, funder, address, MIN_ARKIV[role] * 2n);
    ok(`sent ${formatEther(MIN_ARKIV[role] * 2n)} from your funder wallet (${tx})`);
    gas = await arkivBalance(cfg.arkiv, address);
  }
  if (gas < MIN_ARKIV[role]) {
    console.log(`  Get free Arkiv gas: open ${ARKIV_FAUCET} and paste the same address:\n\n      ${address}\n`);
    if (flags["no-wait"]) warn(`skipped: re-run init or \`npm run kinetic -- status ${role}\` once it's funded`);
    else {
      console.log("  Waiting for it (up to 15 min)…");
      gas = (await waitFor(async () => {
        const b = await arkivBalance(cfg.arkiv, address);
        return b >= MIN_ARKIV[role] ? b : undefined;
      }, WAIT_MS)) ?? gas;
    }
  }
  if (gas >= MIN_ARKIV[role]) ok(`${formatEther(gas)} Arkiv gas`);
  else warn(`only ${formatEther(gas)} Arkiv gas; a ${role} needs ${formatEther(MIN_ARKIV[role])}`);

  // 4. The network you join.
  step("Network");
  settings.HCS_TOPIC_ID = flags.topic ?? settings.HCS_TOPIC_ID ?? TESTNET.hcsTopicId;
  settings.BOND_VAULT_ADDRESS = flags.vault ?? settings.BOND_VAULT_ADDRESS ?? TESTNET.vaultAddress;
  settings.ARKIV_API_KEY = flags["arkiv-api-key"] ?? settings.ARKIV_API_KEY;
  ok(`HCS topic ${settings.HCS_TOPIC_ID}, bond vault ${settings.BOND_VAULT_ADDRESS}`);

  if (role === "buyer") await initBuyer(settings);
  else await initProvider(settings);
  save();

  console.log(`\nSaved to ${path}. Check it any time with: npm run kinetic -- status ${role}`);
  console.log(
    role === "buyer"
      ? "Run a job:           npm run kinetic -- run --task sentiment\nOr from your code:   new Kinetic({ privateKey, hederaAccountId }) — see docs/USE_KINETIC.md"
      : "Start your provider: npm run kinetic -- provider",
  );
}

async function initBuyer(settings: Record<string, string | undefined>): Promise<void> {
  settings.VERIFIER_URL = flags.verifier ?? settings.VERIFIER_URL ?? (await ask("Verifier URL (from the network operator)", TESTNET.verifierUrl));
  const status = await fetch(`${settings.VERIFIER_URL}/status`, { signal: AbortSignal.timeout(5000) })
    .then((r) => (r.ok ? (r.json() as Promise<{ verifier?: string }>) : undefined))
    .catch(() => undefined);
  if (status?.verifier) ok(`verifier ${status.verifier} answers at ${settings.VERIFIER_URL}`);
  else warn(`no verifier answers at ${settings.VERIFIER_URL} yet: jobs need one (ask the operator for its URL, then re-run with --verifier)`);
  // --max-price and --max-spend are in HBAR; the saved settings are already tinybar.
  settings.AGENT_MAX_PRICE_TINYBAR = flags["max-price"] ? String(toTinybar(flags["max-price"])) : (settings.AGENT_MAX_PRICE_TINYBAR ?? String(toTinybar("0.005")));
  settings.AGENT_MAX_JOB_SPEND_TINYBAR = flags["max-spend"] ? String(toTinybar(flags["max-spend"])) : (settings.AGENT_MAX_JOB_SPEND_TINYBAR ?? String(toTinybar("0.5")));
  ok(`spending limits: ${formatHbar(BigInt(settings.AGENT_MAX_PRICE_TINYBAR))} per chunk, ${formatHbar(BigInt(settings.AGENT_MAX_JOB_SPEND_TINYBAR))} per job`);
}

async function initProvider(settings: Record<string, string | undefined>): Promise<void> {
  step("Your provider");
  settings.PROVIDER_NAME = flags.name ?? settings.PROVIDER_NAME ?? (await ask("Name buyers see", hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 24)));
  settings.PROVIDER_PORT = flags.port ?? settings.PROVIDER_PORT ?? "5101";

  // Compute: an explicit choice, a 0G key, or a model server already running on this machine.
  const modelUrl = flags["model-url"] ?? settings.PROVIDER_MODEL_URL ?? "http://localhost:11434/v1";
  const zerogKey = flags["zerog-key"] ?? settings.ZEROG_API_KEY;
  let backend = flags.backend ?? settings.PROVIDER_BACKEND ?? (zerogKey ? "0g" : undefined);
  const models = backend === "0g" ? undefined : await detectModels(modelUrl);
  if (!backend && models?.length) backend = "openai";
  if (!backend) {
    const key = await ask(`No model server at ${modelUrl}. 0G API key (pc.0g.ai), or Enter to stop`, "");
    if (!key) throw new Error(`a provider needs compute: start Ollama (\`ollama pull qwen2.5:7b-instruct\`) or another OpenAI-compatible server and re-run, or pass --zerog-key`);
    settings.ZEROG_API_KEY = key;
    backend = "0g";
  }
  if (backend === "0g") {
    settings.ZEROG_API_KEY = zerogKey ?? settings.ZEROG_API_KEY;
    if (!settings.ZEROG_API_KEY) throw new Error("PROVIDER_BACKEND=0g needs a 0G API key: pass --zerog-key (pc.0g.ai)");
    settings.PROVIDER_MODEL = flags.model ?? settings.PROVIDER_MODEL ?? DEFAULT_0G_WORKER_MODEL;
    settings.PROVIDER_GPU = flags.gpu ?? settings.PROVIDER_GPU ?? "0G Compute (TeeML)";
  } else if (backend === "openai") {
    if (!models) throw new Error(`no OpenAI-compatible server answers at ${modelUrl}; start it or pass --model-url`);
    const preferred = models.find((m) => /instruct/i.test(m)) ?? models[0];
    settings.PROVIDER_MODEL = flags.model ?? settings.PROVIDER_MODEL ?? (await ask(`Model (${models.join(", ")})`, preferred ?? ""));
    if (!settings.PROVIDER_MODEL) throw new Error(`${modelUrl} has no models; pull one first (e.g. \`ollama pull qwen2.5:7b-instruct\`)`);
    settings.PROVIDER_MODEL_URL = modelUrl;
    settings.PROVIDER_GPU = flags.gpu ?? settings.PROVIDER_GPU ?? detectGpu() ?? "CPU";
  } else throw new Error(`--backend must be 0g or openai, got ${backend}`);
  settings.PROVIDER_BACKEND = backend;
  ok(`compute: ${backend === "0g" ? "0G Compute" : modelUrl} running ${settings.PROVIDER_MODEL} on ${settings.PROVIDER_GPU}`);

  // --price and --bond are in HBAR; the saved settings are already tinybar.
  settings.PROVIDER_PRICE_TINYBAR = flags.price ? String(toTinybar(flags.price)) : (settings.PROVIDER_PRICE_TINYBAR ?? String(toTinybar("0.001")));
  settings.PROVIDER_BOND_TINYBAR = flags.bond ? String(toTinybar(flags.bond)) : (settings.PROVIDER_BOND_TINYBAR ?? String(toTinybar("1")));
  ok(`price ${formatHbar(BigInt(settings.PROVIDER_PRICE_TINYBAR))} per chunk, bond ${formatHbar(BigInt(settings.PROVIDER_BOND_TINYBAR))} (posted when you start)`);
  settings.PROVIDER_TASKS ??= "classify,extract,tag";
  settings.PROVIDER_BEHAVIOR = "honest";

  const local = `http://localhost:${settings.PROVIDER_PORT}`;
  settings.PROVIDER_PUBLIC_URL = flags["public-url"] ?? settings.PROVIDER_PUBLIC_URL ?? (await ask("Public URL buyers will call", local));
  if (/localhost|127\.0\.0\.1/.test(settings.PROVIDER_PUBLIC_URL)) {
    warn(`${settings.PROVIDER_PUBLIC_URL} only works for buyers on this machine. For others, open a tunnel`);
    warn(`(e.g. \`cloudflared tunnel --url ${local}\`) and re-run init with --public-url <the https URL it prints>`);
  } else ok(`buyers will call ${settings.PROVIDER_PUBLIC_URL}`);
}

// ── status ───────────────────────────────────────────────────────────────────

async function status(role: Role): Promise<void> {
  const env = loadRole(role);
  const cfg = loadNetworkConfig({ ...env, KINETIC_NETWORK: "testnet" });
  const signer = privateKeyToAccount(env.KINETIC_PRIVATE_KEY as Hex);
  const address = signer.address.toLowerCase();
  let failures = 0;
  const bad = (msg: string) => (failures++, console.log(`  ✗ ${msg}`));
  const check = async (label: string, fn: () => Promise<string>) => {
    try {
      ok(`${label}: ${await fn()}`);
    } catch (err) {
      bad(`${label}: ${(err as Error).message}`);
    }
  };

  console.log(`${role} ${address} (${envPath(role)})`);
  await check("Hedera account", async () => {
    const a = await mirrorAccount(cfg.hedera.mirrorUrl, env.HEDERA_ACCOUNT_ID || address);
    if (!a) throw new Error(`none yet: fund ${address} at ${HEDERA_FAUCET}, then re-run init`);
    if (a.evmAddress && a.evmAddress !== address) throw new Error(`${a.id} belongs to a different key`);
    if (a.hollow) throw new Error(`${a.id} has no key yet: re-run init to activate it`);
    if (a.balanceTinybar < MIN_HBAR[role]) throw new Error(`${a.id} has ${formatHbar(a.balanceTinybar)}, below ${formatHbar(MIN_HBAR[role])}`);
    return `${a.id} holds ${formatHbar(a.balanceTinybar)}`;
  });
  await check("Arkiv gas", async () => {
    const gas = await arkivBalance(cfg.arkiv, address);
    if (gas < MIN_ARKIV[role]) throw new Error(`${formatEther(gas)}, below ${formatEther(MIN_ARKIV[role])} (${ARKIV_FAUCET})`);
    return formatEther(gas);
  });

  const arkiv = new ArkivSdkStore(signer, cfg.arkiv);
  if (role === "buyer") {
    const verifierUrl = env.VERIFIER_URL || TESTNET.verifierUrl;
    await check("verifier", async () => {
      const res = await fetch(`${verifierUrl}/status`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
      if (!res?.ok) throw new Error(`nothing answers at ${verifierUrl}`);
      return `${((await res.json()) as { verifier: string }).verifier} at ${verifierUrl}`;
    });
    await check("providers", async () => {
      const offers = await arkiv.query("offer");
      const names = [...new Set(offers.map((o) => attrStr(o, "name")))];
      return `${names.length} offering work on Arkiv${names.length ? ` (${names.slice(0, 8).join(", ")})` : ""}`;
    });
  } else {
    await check("bond", async () => {
      const bond = await new EvmBondVault(signer, cfg.hedera.vaultAddress!, cfg.hedera).bondOf(address);
      if (bond.slashed) throw new Error("slashed: buyers skip this address for good; start again with a new key");
      if (bond.amountTinybar === 0n) throw new Error("none yet: it's posted when you start your provider");
      const leaving = bond.unlockAt ? `, withdrawal requested (unlocks ${new Date(bond.unlockAt * 1000).toISOString()})` : "";
      return `${formatHbar(bond.amountTinybar)} in the vault${bond.pending ? `, ${bond.pending} slash(es) open` : ""}${leaving}`;
    });
    await check("offer", async () => {
      const offers = await arkiv.query("offer", { provider: address });
      if (offers.length === 0) throw new Error("not on Arkiv: your provider isn't running (offers expire 90 s after it stops)");
      const o = offers[0];
      return `live as ${attrStr(o, "name")} at ${attrStr(o, "endpoint")}, ${formatHbar(attrBig(o, "price"))} per chunk`;
    });
  }
  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll good.");
  process.exitCode = failures ? 1 : 0;
}

// ── run (buyer) ──────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const env = loadRole("buyer");
  // A listed model: its card sets the task; items come from --items (default the ticket set).
  if (flags.model) return runModel(env, flags.model);
  const name = flags.task ?? "sentiment";
  // A built-in task by name, or a task.json / task folder of your own.
  const builtIn = builtInTasks().find((t) => t.name === name);
  const path = builtIn ? (existsSync(`data/tasks/${name}`) ? `data/tasks/${name}` : `data/${name}.task.json`) : name;
  if (!existsSync(path)) throw new Error(`unknown task ${name}: use a built-in one (npm run kinetic -- tasks) or a path to a task.json`);
  const { task, items } = loadJob(path, flags.items);
  const kinetic = Kinetic.fromEnv(
    {
      ...env,
      ...(flags["max-price"] ? { AGENT_MAX_PRICE_TINYBAR: String(toTinybar(flags["max-price"])) } : {}),
      ...(flags["max-spend"] ? { AGENT_MAX_JOB_SPEND_TINYBAR: String(toTinybar(flags["max-spend"])) } : {}),
    },
    { onEvent: (e) => console.log(`${new Date(e.at).toISOString().slice(11, 19)} ${e.message}${e.fields ? ` ${JSON.stringify(e.fields, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}` : ""}`) },
  );
  process.once("SIGINT", () => {
    console.log("\nStopping: no new paid work; chunks in flight finish. Ctrl-C again to quit.");
    kinetic.halt();
  });
  const report = await kinetic.run({ task, items, chunkSize: Number(flags.chunk ?? 5) });
  printReport(report);
  console.log(`  report written to ${writeReport(report)}`);
  process.exitCode = report.status === "complete" ? 0 : 1;
}

const printEvent = (e: { at: number; message: string; fields?: Record<string, unknown> }) =>
  console.log(`${new Date(e.at).toISOString().slice(11, 19)} ${e.message}${e.fields ? ` ${JSON.stringify(e.fields, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}` : ""}`);

function buyerKinetic(env: Record<string, string | undefined>): Kinetic {
  return Kinetic.fromEnv(
    {
      ...env,
      ...(flags["max-price"] ? { AGENT_MAX_PRICE_TINYBAR: String(toTinybar(flags["max-price"])) } : {}),
      ...(flags["max-spend"] ? { AGENT_MAX_JOB_SPEND_TINYBAR: String(toTinybar(flags["max-spend"])) } : {}),
    },
    { onEvent: printEvent },
  );
}

async function runModel(env: Record<string, string | undefined>, ref: string): Promise<void> {
  const kinetic = buyerKinetic(env);
  const listing = await kinetic.model(ref);
  console.log(`  running ${listing.id}@${listing.version} (${listing.key}): benchmark ${Math.round(listing.accuracy * 100)}%, ${listing.card.royaltyBps / 100}% royalty to its creator`);
  const items = readItems(flags.items ?? "data/tickets.jsonl");
  process.once("SIGINT", () => kinetic.halt());
  const report = await kinetic.run({ model: listing.key, items, chunkSize: Number(flags.chunk ?? 5) });
  printReport(report);
  console.log(`  report written to ${writeReport(report)}`);
  process.exitCode = report.status === "complete" ? 0 : 1;
}

function readItems(path: string): Item[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      const v = JSON.parse(l) as Item | string;
      return typeof v === "string" ? { id: String(i + 1), text: v } : v;
    });
}

// ── models ───────────────────────────────────────────────────────────────────

async function models(sub: string | undefined, ref: string | undefined): Promise<void> {
  const kinetic = buyerKinetic(loadRole("buyer"));
  if (!sub || sub === "list") {
    const list = await kinetic.models();
    if (list.length === 0) return console.log("  no models listed yet: publish one with npm run kinetic -- models publish --card card.json");
    for (const m of list)
      console.log(`  ${`${m.id}@${m.version}`.padEnd(40)} ${m.key}  ${m.card.task.kind.padEnd(8)} benchmark ${String(Math.round(m.accuracy * 100)).padStart(3)}%  royalty ${m.card.royaltyBps / 100}%  ${m.weightsChecked ? `${(m.params ?? 0).toLocaleString("en-US")} params, malware-checked` : `served by 0G (${m.card.runtime.model})`}  ${m.signers.length} verifiers`);
    return;
  }
  if (sub === "show") {
    if (!ref) throw new Error("which model? npm run kinetic -- models show <id[@version]|key>");
    const { listing, passport, checks } = await kinetic.passport(ref);
    console.log(`\n  ${listing.name}: ${listing.id}@${listing.version} (${listing.key})`);
    console.log(`  ${listing.card.description}`);
    console.log(`  creator ${listing.card.creator.address} · royalty ${listing.card.royaltyBps / 100}% to ${listing.card.creator.payTo} · licence ${listing.card.license}`);
    console.log(`  runs on ${listing.card.runtime.engine}:${listing.card.runtime.model} · task ${listing.card.task.kind}${listing.card.task.labels ? ` (${listing.card.task.labels.map((l) => l.name).join(", ")})` : ""}`);
    console.log(`  Model Passport: ${kinetic.svc.swarm.url(listing.passportRef)}${listing.feed ? `\n  Newest passport of ${listing.id} (signed feed): ${kinetic.svc.swarm.feedUrl(listing.feed.manifest)}` : ""}\n`);
    for (const c of checks) console.log(`  ${c.ok === true ? "✓" : c.ok === false ? "✗" : "·"} ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
    console.log("");
    for (const l of passport.limitations) console.log(`  - ${l}`);
    process.exitCode = checks.some((c) => c.ok === false) ? 1 : 0;
    return;
  }
  if (sub === "publish") {
    if (!flags.card) throw new Error("publish needs --card card.json (and --weights <folder> for a model providers run themselves)");
    const card = JSON.parse(readFileSync(flags.card, "utf8")) as PublishInput["card"];
    const files = flags.weights ? readdirSync(flags.weights).filter((f) => statSync(join(flags.weights!, f)).isFile()).map((name) => ({ name, path: join(flags.weights!, name) })) : undefined;
    const benchmark = flags.benchmark ? (readItems(flags.benchmark) as PublishInput["benchmark"]) : undefined;
    console.log(`  publishing ${card.id}@${card.version}: the verifier quorum reviews it (this takes a minute)…`);
    if (flags.storage && flags.storage !== "0g" && flags.storage !== "swarm") throw new Error("--storage must be 0g or swarm");
    const out = await kinetic.publish({ card, ...(files ? { files } : {}), ...(benchmark ? { benchmark } : {}), ...(flags.storage ? { storage: flags.storage as "0g" | "swarm" } : {}) });
    console.log(`\n  ✓ listed ${out.id}@${out.version} as ${out.key}: benchmark ${Math.round(out.accuracy * 100)}%, signed by ${out.signers.length} verifiers`);
    console.log(`  Model Passport: ${kinetic.svc.swarm.url(out.passportRef)}`);
    if (out.feeTx) console.log(`  listing fee: ${out.feeTx}`);
    return;
  }
  throw new Error(`unknown models command ${sub}: list, show or publish`);
}

// ── provider ─────────────────────────────────────────────────────────────────

async function provider(): Promise<void> {
  const env = loadRole("provider");
  const cfg = loadNetworkConfig({ ...env, KINETIC_NETWORK: "testnet" });
  const svc = connect(cfg, identityFromEnv(env));
  const node = await startProvider(await providerOptionsFromEnv(env, cfg, svc), svc);
  console.log(`\nYour provider is live. Buyers find it on Arkiv; check it with: npm run kinetic -- status provider`);
  console.log("Stop it with Ctrl-C (your offer disappears within 90 s). To leave the network: npm run bonds -- request --yes");
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      await node.close();
      process.exit(0);
    });
  }
}

// ── tasks ────────────────────────────────────────────────────────────────────

function tasks(): void {
  for (const t of builtInTasks()) console.log(`  ${t.name.padEnd(18)} ${t.kind.padEnd(9)} ${t.knownAnswers ? "known answers: wrong answers can be slashed" : "format and model checks only"}`);
}

const HELP = `Usage: npm run kinetic -- <command>

  init [buyer|provider]    set up your key, Hedera account, Arkiv gas and settings
  status [buyer|provider]  check your account, gas, and (providers) your bond and live offer
  run --task <name>        run a job: --items file.jsonl --chunk 5 --max-spend 0.5
  run --model <id>         run a listed model on your items (--items file.jsonl); pays its creator a royalty
  models [list]            the models listed in the registry, with their benchmark and royalty
  models show <id>         a model's card and Model Passport, with every check on it
  models publish           list your model: --card card.json [--weights <folder>] [--storage 0g|swarm] [--benchmark labelled.jsonl]
  provider                 start your provider node (serve listed models with PROVIDER_MODELS)
  tasks                    list the built-in tasks

init options: --operator-id/--operator-key (fund from an account you have), --arkiv-funder-key,
  --no-wait, --yes, --verifier <url>; providers: --name --public-url --zerog-key --model-url
  --model --gpu --price 0.001 --bond 1. Settings: .kinetic/<role>.env (or --env <file>).`;

try {
  if (flags.help || !command) console.log(HELP);
  else if (command === "init") await init(parseRole(arg, "buyer"));
  else if (command === "status") await status(parseRole(arg, existsSync(envPath("provider")) && !existsSync(envPath("buyer")) ? "provider" : "buyer"));
  else if (command === "run") await run();
  else if (command === "provider") await provider();
  else if (command === "tasks") tasks();
  else if (command === "models") await models(arg, positionals[2]);
  else {
    console.log(HELP);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`\n✗ ${(err as Error).message}`);
  process.exitCode = 1;
}
