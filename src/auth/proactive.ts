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
