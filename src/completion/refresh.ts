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
 * `__refresh-completion`. Handles both the compiled-binary form and the
 * runtime form.
 *
 * IMPORTANT: do not use `argv[0]` as the executable. In a `bun build --compile`
 * standalone binary, Bun sets `process.argv[0]` to the literal string "bun"
 * (not a path), so spawning it fails with ENOENT on machines without Bun.
 * `process.execPath` always points at the actual running executable — the
 * standalone binary when compiled, or the `bun` runtime in dev — so we re-spawn
 * that instead. The script path is only re-passed when the runtime is itself
 * Bun (the dev/`bun run src/index.ts` form).
 */
export function reinvokeArgv(
  argv: string[],
  execPath: string = process.execPath,
): [string, string[]] {
  const runtimeIsBun = /(^|[/\\])bun(\.exe)?$/i.test(execPath);
  const maybeScript = argv[1] ?? "";
  if (runtimeIsBun && /\.(ts|js|mjs|cjs)$/.test(maybeScript)) {
    return [execPath, [maybeScript, REFRESH_SENTINEL]];
  }
  return [execPath, [REFRESH_SENTINEL]];
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
    // A missing/unspawnable executable surfaces as an async 'error' event, not
    // a synchronous throw, so the surrounding try/catch cannot swallow it.
    // Attach a no-op handler so a failed background refresh stays silent.
    child.on("error", () => {});
    child.unref();
  } catch {
    // background refresh is best-effort
  }
}
