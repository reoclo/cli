// src/completion/refresh.ts
//
// Spawns a detached `__refresh-completion` process so an authenticated
// command can keep the completion cache fresh without paying any latency.

import { spawn } from "node:child_process";
import { INDEX_KINDS } from "./types";
import { sliceAge } from "./cache";

const STALE_MS = 60_000;

/**
 * Given a process argv, return [executable, args] to re-invoke the CLI with
 * `__refresh-completion`. Handles both the compiled-binary form (argv =
 * [binary, ...userArgs]) and the runtime form (argv = [runtime, script, ...]).
 */
export function reinvokeArgv(argv: string[]): [string, string[]] {
  const exe = argv[0] ?? process.execPath;
  const maybeScript = argv[1] ?? "";
  if (/\.(ts|js|mjs)$/.test(maybeScript)) {
    return [exe, [maybeScript, "__refresh-completion"]];
  }
  return [exe, ["__refresh-completion"]];
}

/** True if any index slice is older than the staleness threshold. */
export function indexIsStale(): boolean {
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
