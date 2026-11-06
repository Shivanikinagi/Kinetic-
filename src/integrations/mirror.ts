import { mirrorTransactionId } from "./x402.js";

// The verifier never takes a buyer's word for what it paid: refunds are sized from the HBAR
// transfers the mirror node shows for each settled x402 transaction. `asset` is only for
// checking passports of jobs from before payments became HBAR-only, which settled in an HTS token.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function creditedAmount(mirrorUrl: string, tx: string, payTo: string, asset = "0.0.0", attempts = 10): Promise<bigint> {
  const id = mirrorTransactionId(tx);
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(`${mirrorUrl}/api/v1/transactions/${id}`);
    if (res.ok) {
      const body = (await res.json()) as {
        transactions?: {
          result: string;
          transfers?: { account: string; amount: number | string }[];
          token_transfers?: { token_id: string; account: string; amount: number | string }[];
        }[];
      };
      const t = body.transactions?.[0];
      if (t) {
        if (t.result !== "SUCCESS") return 0n;
        const moves = asset === "0.0.0" ? (t.transfers ?? []) : (t.token_transfers ?? []).filter((x) => x.token_id === asset);
        return moves
          .filter((x) => x.account.toLowerCase() === payTo.toLowerCase())
          .reduce((sum, x) => sum + BigInt(x.amount), 0n);
      }
    }
    // The mirror node lags consensus by a few seconds.
    await sleep(1500);
  }
  return 0n;
}
