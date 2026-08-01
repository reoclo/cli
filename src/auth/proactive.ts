// src/auth/proactive.ts
//
// Proactive OAuth refresh: refresh the access token BEFORE it expires so a
// long-idle CLI command or a long-lived MCP session never eats an expiry-driven
// 401. Pure decision helpers here; the imperative loop (Task 4) injects timers.

/** Refresh this long before the access token's `exp`. */
export const PROACTIVE_SKEW_MS = 120_000;

/** When missing/unparseable we fall back to the reactive 401 path, so treat as
 *  "no refresh needed here" rather than forcing one on a bad timestamp. */
export function needsProactiveRefresh(
  expiresAt: string | undefined,
  now: number,
  skewMs: number,
): boolean {
  if (!expiresAt) return false;
  const exp = Date.parse(expiresAt);
  if (Number.isNaN(exp)) return false;
  return now >= exp - skewMs;
}

/** Milliseconds until the next proactive refresh. Due-now → 0 (never negative).
 *  Missing/unparseable expiry → a coarse re-check interval so the loop re-arms
 *  and picks up an expiry the next time one is persisted. */
export function nextRefreshDelayMs(
  expiresAt: string | undefined,
  now: number,
  skewMs: number,
): number {
  if (!expiresAt) return skewMs;
  const exp = Date.parse(expiresAt);
  if (Number.isNaN(exp)) return skewMs;
  return Math.max(0, exp - skewMs - now);
}

/** Apply a best-effort proactive refresh: when a refresh callback exists and the
 *  token is within the skew of expiry, refresh and return the fresh token; a null
 *  (transient) result or no-refresh-needed returns the original token unchanged.
 *  A thrown ReauthRequiredError propagates (same as the reactive 401 path). */
export async function applyProactiveRefresh(
  token: string,
  expiresAt: string | undefined,
  refresh: ((currentToken: string) => Promise<string | null>) | undefined,
  now: number,
  skewMs: number,
): Promise<string> {
  if (refresh && needsProactiveRefresh(expiresAt, now, skewMs)) {
    const fresh = await refresh(token);
    if (fresh) return fresh;
  }
  return token;
}

export interface TokenRefreshLoopDeps {
  refresh: (currentToken: string) => Promise<string | null>;
  onToken: (token: string) => void;
  getExpiresAt: () => Promise<string | undefined>;
  initialToken: string;
  initialExpiresAt: string | undefined;
  skewMs: number;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

/**
 * Keep a long-lived client's OAuth token fresh: arm a timer for `expiry - skew`,
 * refresh (single-flight, shared with the reactive path), push the new token to
 * the client, re-read the persisted expiry, and re-arm. Best-effort: a null or
 * thrown refresh is swallowed and the loop re-arms from a coarse interval so a
 * transient failure never kills the session. Returns a `stop()`.
 *
 * The loop tracks the current token itself (seeded from `initialToken`, updated
 * from each successful refresh) rather than asking the caller for it on every
 * cycle. A caller-supplied `currentToken()` getter is a footgun: it is easy to
 * wire it to a snapshot that is never reassigned (e.g. a plain string captured
 * at startup) while `onToken` writes the fresh value somewhere else entirely
 * (e.g. into an HttpClient's private field) - the two silently drift apart, the
 * loop keeps refreshing with the same stale token forever, the reactive
 * double-check in refreshSession() sees the store has already moved on and
 * bails out without refreshing, and the persisted expiry never advances, so the
 * loop eventually tight-spins. Owning the token internally makes that
 * impossible to wire wrong.
 */
export function startTokenRefreshLoop(deps: TokenRefreshLoopDeps): () => void {
  let handle: unknown;
  let stopped = false;
  let expiresAt = deps.initialExpiresAt;
  let currentToken = deps.initialToken;

  const arm = (): void => {
    if (stopped) return;
    const delay = nextRefreshDelayMs(expiresAt, deps.now(), deps.skewMs);
    // A real setTimeout-backed setTimer discards a callback's return value, so
    // this is fire-and-forget in production exactly like `void tick()` would
    // be. Returning tick()'s promise here (instead of voiding it) only matters
    // to a test harness that stores and awaits the callback directly, letting
    // it observe the full refresh-then-rearm chain deterministically.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    handle = deps.setTimer(() => tick(), delay);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const fresh = await deps.refresh(currentToken);
      if (fresh) {
        currentToken = fresh;
        deps.onToken(fresh);
      }
      expiresAt = await deps.getExpiresAt();
    } catch {
      // Best-effort: a ReauthRequiredError or transient failure must not crash
      // the server. Leave the reactive 401 path to surface a genuine re-login.
      expiresAt = undefined; // coarse re-check
    }
    arm();
  };

  arm();
  return () => { stopped = true; deps.clearTimer(handle); };
}
