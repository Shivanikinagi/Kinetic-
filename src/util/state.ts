import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NetworkConfig } from "../config.js";

// Local state a role needs after a restart. It can hold secrets (a job's master key), so files
// are owner-only and live under .kinetic/, which is git-ignored.

/** Path of a state file, or undefined when this role keeps no state on disk. */
export function stateFile(cfg: Pick<NetworkConfig, "stateDir">, ...parts: string[]): string | undefined {
  return cfg.stateDir ? join(cfg.stateDir, ...parts) : undefined;
}

/** Writes JSON through a temporary file and a rename, so a crash never leaves half a file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, file);
}
