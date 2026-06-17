// src/client/update-check.ts
//
// Pure decision logic for the on-run auto-update notice. The CLI checks GitHub
// for a newer release at most once a day (in a detached background process —
// see the wiring in index.ts), caches the answer, and prints a single
// stderr line pointing at the right upgrade command for the user's install
// method. All network / fs / clock inputs are injected so this stays testable.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cacheDir } from "../config/paths";
import { detectInstallMethod, resolveLatestVersion, type InstallMethod } from "../commands/upgrade";
import { upgradeCommandFor } from "./upgrade-hint";

export interface UpdateCache {
  latest?: string;
  checked_at?: string;
  notified_at?: string;
}

/** Check GitHub for a newer release at most once per this window. */
export const CHECK_TTL_MS = 24 * 60 * 60 * 1000;
/** Show the "update available" line at most once per this window. */
export const NOTIFY_THROTTLE_MS = 24 * 60 * 60 * 1000;

const SENTINEL = "__update-check";

/**
 * Re-invoke argv to run the hidden `__update-check` sentinel. Mirrors
 * completion's reinvokeArgv: a `bun build --compile` binary sets argv[0] to the
 * literal "bun", so we re-spawn via process.execPath (the real binary), only
 * re-passing the script path when the runtime itself is bun (dev form).
 */
export function reinvokeForUpdateCheck(
  argv: string[],
  execPath: string = process.execPath,
): [string, string[]] {
  const runtimeIsBun = /(^|[/\\])bun(\.exe)?$/i.test(execPath);
  const maybeScript = argv[1] ?? "";
  if (runtimeIsBun && /\.(ts|js|mjs|cjs)$/.test(maybeScript)) {
    return [execPath, [maybeScript, SENTINEL]];
  }
  return [execPath, [SENTINEL]];
}

/**
 * One pass of the notice machinery: print the upgrade line when a newer version
 * is cached (throttled), and schedule a background re-check when the cache has
 * gone stale. All side effects are injected so the orchestration stays testable.
 */
export function runUpdateCheckCycle(deps: {
  current: string;
  now: number;
  ttlMs: number;
  throttleMs: number;
  readCache: () => UpdateCache;
  writeCache: (c: UpdateCache) => void;
  detectMethod: () => InstallMethod;
  emit: (line: string) => void;
  spawnCheck: () => void;
}): void {
  const cache = deps.readCache();
  if (
    shouldNotify({
      current: deps.current,
      latest: cache.latest,
      notifiedAt: cache.notified_at,
      now: deps.now,
      throttleMs: deps.throttleMs,
    })
  ) {
    deps.emit(formatUpdateNotice(deps.current, cache.latest as string, deps.detectMethod()));
    deps.writeCache({ ...cache, notified_at: new Date(deps.now).toISOString() });
  }
  if (isCheckStale(cache.checked_at, deps.now, deps.ttlMs)) {
    deps.spawnCheck();
  }
}

// ── Real I/O glue (thin; the testable decisions live in the pure helpers) ─────

export function updateCachePath(): string {
  return join(cacheDir(), "update-check.json");
}

/** Total / offline: any read or parse error yields empty defaults. */
export function readUpdateCache(): UpdateCache {
  try {
    const p = updateCachePath();
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf8")) as UpdateCache;
  } catch {
    return {};
  }
}

/** Best-effort write; never throws. */
export function writeUpdateCache(cache: UpdateCache): void {
  try {
    const p = updateCachePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(cache, null, 2));
  } catch {
    // best-effort
  }
}

/** Fire-and-forget detached `__update-check` process. Never throws. */
export function maybeSpawnBackgroundUpdateCheck(): void {
  try {
    const [exe, args] = reinvokeForUpdateCheck(process.argv);
    const child = spawn(exe, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // best-effort
  }
}

/**
 * What the hidden `__update-check` background process runs: ask GitHub for the
 * latest stable tag and cache it (preserving notified_at). Silent on failure.
 */
export async function performUpdateCheck(): Promise<void> {
  try {
    const latest = (await resolveLatestVersion("stable")).replace(/^v/, "");
    writeUpdateCache({ ...readUpdateCache(), latest, checked_at: new Date().toISOString() });
  } catch {
    // silent — background check must never surface errors
  }
}

/** Build the cycle deps from real I/O and run it (called from index.ts). */
export function maybeNotifyUpdate(current: string): void {
  runUpdateCheckCycle({
    current,
    now: Date.now(),
    ttlMs: CHECK_TTL_MS,
    throttleMs: NOTIFY_THROTTLE_MS,
    readCache: readUpdateCache,
    writeCache: writeUpdateCache,
    detectMethod: () => detectInstallMethod(process.execPath),
    emit: (line) => process.stderr.write(`${line}\n`),
    spawnCheck: maybeSpawnBackgroundUpdateCheck,
  });
}

/** Parse "x.y.z" (leading v and any pre-release suffix tolerated) → [maj,min,pat]. */
function parseVersion(v: string): [number, number, number] {
  const core = v.replace(/^v/, "").split("-")[0] ?? "";
  const [maj, min, pat] = core.split(".");
  return [Number(maj) || 0, Number(min) || 0, Number(pat) || 0];
}

/** True when `latest` is a strictly higher version than `current`. */
export function isNewer(current: string, latest: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  for (let i = 0; i < 3; i++) {
    if (b[i]! > a[i]!) return true;
    if (b[i]! < a[i]!) return false;
  }
  return false;
}

/** True when the last check is missing, unparseable, or older than `ttlMs`. */
export function isCheckStale(
  checkedAt: string | undefined,
  now: number,
  ttlMs: number,
): boolean {
  if (!checkedAt) return true;
  const t = Date.parse(checkedAt);
  if (Number.isNaN(t)) return true;
  return now - t >= ttlMs;
}

/** True when a newer version is known and we haven't nagged within `throttleMs`. */
export function shouldNotify(args: {
  current: string;
  latest: string | undefined;
  notifiedAt: string | undefined;
  now: number;
  throttleMs: number;
}): boolean {
  if (!args.latest || !isNewer(args.current, args.latest)) return false;
  if (!args.notifiedAt) return true;
  const t = Date.parse(args.notifiedAt);
  if (Number.isNaN(t)) return true;
  return args.now - t >= args.throttleMs;
}

/**
 * Whether the update-check machinery should run at all. Suppressed by an
 * explicit opt-out (env / flag), in non-interactive contexts (no stderr TTY,
 * machine output, automation-key CI), and under --quiet — so it never corrupts
 * scripts or nags CI.
 */
export function shouldRunUpdateCheck(args: {
  disabledByEnv: boolean;
  disabledByFlag: boolean;
  isTTY: boolean;
  outputFormat: string;
  automationKey: boolean;
  quiet: boolean;
}): boolean {
  if (args.disabledByEnv || args.disabledByFlag) return false;
  if (!args.isTTY) return false;
  if (args.outputFormat !== "text") return false;
  if (args.automationKey) return false;
  if (args.quiet) return false;
  return true;
}

/** The single-line notice shown on stderr when a newer version is available. */
export function formatUpdateNotice(
  current: string,
  latest: string,
  method: InstallMethod,
): string {
  const bare = latest.replace(/^v/, "");
  return `⚡ reoclo ${bare} available (you have ${current}) — ${upgradeCommandFor(method, bare)}`;
}
