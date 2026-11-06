// Model fingerprinting: does a provider run the model it declares? Every capable model labels
// clear-cut tickets the same way, so those can't tell models apart. Borderline tickets can: a
// model that is asked "charged twice after the checkout crashed" consistently says billing,
// another consistently says bug. `npm run fingerprint` measures real models on borderline
// tickets and keeps, for each model, the ones it answers the same way every time and where
// other models differ. The verifier sends a provider a paid chunk of those, looking like any
// other chunk, and compares its answers with each known model's.
//
// It is statistical evidence, not proof: a provider could run the declared model only for
// chunks it guesses are probes, and a model update can shift its answers. So the result is
// recorded and shown, and never slashes.

export interface FingerprintItem {
  id: string;
  text: string;
  /** What the model this probe belongs to answers, every time. */
  label: string;
}

export interface FingerprintSet {
  /** Path of the task the answers are for. */
  task: string;
  builtAt: string;
  /** Every measured model's stable answers, by item id. */
  models: Record<string, Record<string, string>>;
  /** For each model, the items that tell it apart from the others. */
  probes: Record<string, FingerprintItem[]>;
}

export type FingerprintVerdict = "consistent" | "mismatch" | "inconclusive";

export interface FingerprintResult {
  /** The model the provider declares, e.g. "0gm-1.0-35b-a3b". */
  declared: string;
  /** Share of probe items answered like the declared model, 0..1. */
  match: number;
  verdict: FingerprintVerdict;
  /** The known model whose answers this provider matched best, when it isn't the declared one. */
  closest?: string;
  closestMatch?: number;
  items: number;
}

/** The model name inside a declared backend: "0g:0gm-1.0-35b-a3b" → "0gm-1.0-35b-a3b". */
export function modelOf(backend: string | undefined): string | undefined {
  if (!backend) return undefined;
  const i = backend.indexOf(":");
  return i < 0 ? backend : backend.slice(i + 1);
}

/**
 * Picks each model's probe items from repeated runs: items it answered the same way every run
 * (stable), where at least `minOthers` other models stably answered differently. The most
 * telling items (the most models disagreeing) come first.
 */
export function buildProbes(
  runs: Record<string, Record<string, string>[]>,
  texts: Record<string, string>,
  opts: { perModel?: number; minOthers?: number } = {},
): Pick<FingerprintSet, "models" | "probes"> {
  const perModel = opts.perModel ?? 12;
  const minOthers = opts.minOthers ?? 1;
  const models: Record<string, Record<string, string>> = {};
  for (const [model, rs] of Object.entries(runs)) {
    const stable: Record<string, string> = {};
    for (const id of Object.keys(texts)) {
      const answers = rs.map((r) => r[id]);
      if (answers.every((a) => a !== undefined && a === answers[0])) stable[id] = answers[0];
    }
    models[model] = stable;
  }
  const probes: Record<string, FingerprintItem[]> = {};
  for (const [model, mine] of Object.entries(models)) {
    probes[model] = Object.entries(mine)
      .map(([id, label]) => ({ id, label, others: Object.entries(models).filter(([m, a]) => m !== model && a[id] !== undefined && a[id] !== label).length }))
      .filter((x) => x.others >= minOthers)
      .sort((a, b) => b.others - a.others || a.id.localeCompare(b.id))
      .slice(0, perModel)
      .map(({ id, label }) => ({ id, text: texts[id], label }));
  }
  return { models, probes };
}

/** Compares a provider's answers on probe items with the declared model's, and with every other known model's. */
export function judgeFingerprint(answers: Record<string, string>, set: Pick<FingerprintSet, "models">, declared: string): FingerprintResult {
  const mine = set.models[declared] ?? {};
  const ids = Object.keys(answers).filter((id) => mine[id] !== undefined);
  const rate = (labels: Record<string, string>) => {
    const known = ids.filter((id) => labels[id] !== undefined);
    return known.length ? known.filter((id) => labels[id] === answers[id]).length / known.length : 0;
  };
  const match = rate(mine);
  let closest: string | undefined;
  let closestMatch = -1;
  for (const [model, labels] of Object.entries(set.models)) {
    if (model === declared) continue;
    const r = rate(labels);
    if (r > closestMatch) [closest, closestMatch] = [model, r];
  }
  const round = (x: number) => Math.round(x * 100) / 100;
  // Calibrated on real runs over 12 probe items: honest providers on 0gm-1.0-35b-a3b matched
  // its fingerprint 75-100% (three scripted runs and two live testnet probes); the same probes
  // answered by qwen2.5:3b matched 50%, and a provider that never calls a model 33%. Only the
  // declared model's match decides: similar large models often share answers, so "another model
  // matches better" is shown as the closest model but is no evidence on its own (it once
  // flagged an honest provider).
  let verdict: FingerprintVerdict;
  if (ids.length < 3) verdict = "inconclusive";
  else if (match >= 0.75) verdict = "consistent";
  else if (match < 0.6) verdict = "mismatch";
  else verdict = "inconclusive";
  return {
    declared,
    match: round(match),
    verdict,
    items: ids.length,
    ...(verdict !== "consistent" && closest !== undefined && closestMatch > match ? { closest, closestMatch: round(closestMatch) } : {}),
  };
}
