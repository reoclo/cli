// src/completion/refresh.ts
//
// Spawns a detached `__refresh-completion` process so an authenticated
// command can keep the completion cache fresh without paying any latency.

import { spawn } from "node:child_process";
import { INDEX_KINDS } from "./types";
import { sliceAge } from "./cache";

const STALE_MS = 60_000;
const REFRESH_SENTINEL = "__refresh-completion";

/**
 * Given a process argv, return [executable, args] to re-invoke the CLI with
 * `__refresh-completion`. Handles both the compiled-binary form (argv =
 * [binary, ...userArgs]) and the runtime form (argv = [runtime, script, ...]).
 */
export function reinvokeArgv(argv: string[]): [string, string[]] {
  const exe = argv[0] ?? process.execPath;
  const maybeScript = argv[1] ?? "";
  if (/\.(ts|js|mjs|cjs)$/.test(maybeScript)) {
    return [exe, [maybeScript, REFRESH_SENTINEL]];
  }
  return [exe, [REFRESH_SENTINEL]];
}

/**
 * True if any index slice is older than the staleness threshold.
 * Note: sliceAge reads the cache file once per kind, which is intentionally
 * acceptable here because indexIsStale runs at most once per CLI invocation.
 */
export function indexIsStale(): boolean {
  // sliceAge returns Infinity for a never-populated slice, so a fresh install
  // where `completion warm` has never succeeded intentionally counts as stale
  // and triggers a background refresh — do not "optimise" this away.
  return INDEX_KINDS.some((k) => sliceAge(k) > STALE_MS);
}

/**
 * Fire-and-forget: if the cache is stale, spawn a detached refresh process.
 * Never throws — a failed spawn is swallowed.
 */
export function maybeSpawnBackgroundRefresh(): void {
  try {
    if (!indexIsStale()) return;
    const [exe, args] = reinvokeArgv(process.argv);
    const child = spawn(exe, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // background refresh is best-effort
  }
}
