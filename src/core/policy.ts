// Slashing rule: a provider is slashed once `failLimit` of its last `window` canaries fail
// (default 3 of 10). A canary fails when its agreement with the 0G reference is below
// `minAgreement`. Tune all three to what you measure on real models.

export interface CanaryPolicy {
  window: number;
  failLimit: number;
  minAgreement: number;
}

export class CanaryWindow {
  private readonly outcomes: boolean[] = [];

  constructor(private readonly policy: CanaryPolicy) {}

  record(pass: boolean): void {
    this.outcomes.push(pass);
    if (this.outcomes.length > this.policy.window) this.outcomes.shift();
  }

  get failures(): number {
    return this.outcomes.filter((pass) => !pass).length;
  }

  get size(): number {
    return this.outcomes.length;
  }

  get breached(): boolean {
    return this.failures >= this.policy.failLimit;
  }

  /** Outcomes oldest first, "1" for a pass and "0" for a failure, for the reputation entity. */
  toString(): string {
    return this.outcomes.map((pass) => (pass ? "1" : "0")).join("");
  }

  /** Rebuilds a window from `toString()`, so a verifier restart keeps a provider's recent failures. */
  static restore(policy: CanaryPolicy, saved: string): CanaryWindow {
    const w = new CanaryWindow(policy);
    for (const c of saved) if (c === "0" || c === "1") w.record(c === "1");
    return w;
  }
}
