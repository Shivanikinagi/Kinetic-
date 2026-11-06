import { mkdirSync, writeFileSync } from "node:fs";

// Writes data/tickets.jsonl: synthetic customer-support tickets for demos and tests.
// Seeded, so the output is identical on every run.

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

const names = ["asha", "ravi", "meera", "john", "li", "sara", "omar", "priya", "dev", "nina"];
const order = () => `ORD-${1000 + Math.floor(rand() * 9000)}`;
const money = () => `$${(5 + rand() * 200).toFixed(2)}`;
const email = () => `${pick(names)}${Math.floor(rand() * 90 + 10)}@example.com`;

const templates: Record<string, (() => string)[]> = {
  billing: [
    () => `I was charged twice for ${order()}, please refund ${money()}.`,
    () => `My card payment of ${money()} failed but the invoice says paid. Contact me at ${email()}.`,
    () => `Need a copy of the invoice for ${order()} for my records.`,
    () => `Why was I charged ${money()} after cancelling? I want a refund.`,
  ],
  bug: [
    () => `The app crashes every time I open the reports tab.`,
    () => `Getting an error 500 when saving settings, looks like a bug.`,
    () => `Export button is broken since the last update.`,
    () => `The dashboard freezes after login on Android.`,
  ],
  account: [
    () => `I forgot my password and the reset link never arrives at ${email()}.`,
    () => `My account is locked after too many login attempts.`,
    () => `How do I turn off two-factor on my account?`,
    () => `Please change the email address on my profile to ${email()}.`,
  ],
  shipping: [
    () => `My package for ${order()} has not arrived, tracking shows no update.`,
    () => `The courier says delivery failed, can you reship ${order()}?`,
    () => `Order ${order()} shipped a week ago, where is my package?`,
    () => `Tracking number for ${order()} does not work.`,
  ],
  feature_request: [
    () => `Would love a dark mode option in the web app.`,
    () => `Please add support for exporting to CSV.`,
    () => `Feature idea: let us schedule reports weekly.`,
    () => `I wish there was support for multiple currencies.`,
  ],
  other: [
    () => `Just wanted to say the team was very helpful today.`,
    () => `Do you have an office in Mumbai?`,
    () => `What are your opening hours during the holidays?`,
  ],
};

const categories = Object.keys(templates);
const lines: string[] = [];
for (let i = 0; i < 120; i++) {
  const category = pick(categories);
  lines.push(JSON.stringify({ id: `t${String(i + 1).padStart(3, "0")}`, text: pick(templates[category])() }));
}

mkdirSync("data", { recursive: true });
writeFileSync("data/tickets.jsonl", lines.join("\n") + "\n");
console.log(`wrote data/tickets.jsonl (${lines.length} tickets)`);

// Known-answer set for provider qualification. Labels are true by construction (each text
// comes from its category's templates), so they don't depend on any model being right.
// Generated after the tickets so tickets.jsonl stays identical.
const gold: string[] = [];
for (let i = 0; i < 36; i++) {
  const label = categories[i % categories.length];
  gold.push(JSON.stringify({ id: `g${String(i + 1).padStart(3, "0")}`, text: pick(templates[label])(), label }));
}
writeFileSync("data/gold-tickets.jsonl", gold.join("\n") + "\n");
console.log(`wrote data/gold-tickets.jsonl (${gold.length} labelled tickets)`);
