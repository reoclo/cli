// src/config/file-lock.ts
//
// Minimal cross-process advisory lock built on an atomic O_EXCL lock file.
// Used to serialize OAuth token refresh across concurrent `reoclo` processes
// (parallel agents / CI) so two of them don't both spend a rotating refresh
// token and trip the auth server's reuse-detection (which revokes the session).
//
// On contention it waits up to `timeoutMs`; if it still can't acquire it throws
// {@link LockTimeoutError} rather than running `fn` unlocked — the caller decides
// what to do (the refresh path treats a timeout as transient and surfaces the
// original 401 instead of risking a concurrent double-spend).

import { mkdirSync } from "node:fs";
import { open, unlink, stat, rename } from "node:fs/promises";
import { dirname } from "node:path";

/** Thrown by {@link withFileLock} when the lock can't be acquired before the deadline. */
export class LockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockTimeoutError";
  }
}

export interface FileLockOptions {
  /** Max time to wait to acquire before throwing LockTimeoutError. */
  timeoutMs?: number;
  /** Steal a lock whose file is older than this (crashed holder). */
  staleMs?: number;
  /** Poll interval while waiting. */
  retryMs?: number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 0700 dir / 0600 file — the lock lives next to credentials; keep it owner-only. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Run `fn` while holding an exclusive lock at `lockPath`. The lock file (and any
 * missing parent dirs) is created atomically and owner-only; it is always
 * removed when `fn` settles, whether it resolves or rejects. Throws
 * {@link LockTimeoutError} if the lock can't be acquired within `timeoutMs`.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 30_000;
  const retryMs = opts.retryMs ?? 50;
  const sleep = opts.sleep ?? DEFAULT_SLEEP;

  mkdirSync(dirname(lockPath), { recursive: true, mode: DIR_MODE });
  const deadline = Date.now() + timeoutMs;

  let acquired = false;
  while (!acquired) {
    try {
      const fh = await open(lockPath, "wx", FILE_MODE); // wx = O_CREAT | O_EXCL → fails if it exists
      await fh.close();
      acquired = true;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Held by someone else — steal if stale, otherwise wait.
      try {
        const s = await stat(lockPath);
        if (Date.now() - s.mtimeMs > staleMs) {
          // Atomic steal: only the process that wins the rename gets to remove
          // it, so two stealers can't both delete and re-create (which would let
          // both proceed). Losers get ENOENT and just retry.
          const tomb = `${lockPath}.stale-${process.pid}`;
          try {
            await rename(lockPath, tomb);
            await unlink(tomb).catch(() => {});
          } catch {
            // lost the steal race or the lock vanished — fall through to retry
          }
          continue;
        }
      } catch {
        continue; // lock vanished between open and stat — retry immediately
      }
      if (Date.now() >= deadline) {
        throw new LockTimeoutError(`could not acquire lock ${lockPath} within ${timeoutMs}ms`);
      }
      await sleep(retryMs);
    }
  }

  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}
