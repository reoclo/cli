// src/auth/refresh.ts
//
// OAuth token-refresh orchestration with double-checked locking and in-process
// single-flight. Refresh tokens rotate (each use mints a new one and revokes
// the old), so two refreshers spending the same token trips the auth server's
// reuse-detection and revokes the whole session. This module guarantees at most
// one refresh per profile actually runs, and that a waiter re-uses the freshly
// stored token instead of refreshing again.

import type { TokenStore } from "../config/token-store";
import { refreshTokenKeyCandidates } from "../config/token-store";
import { ReauthRequiredError } from "../client/errors";
import { LockTimeoutError } from "../config/file-lock";
import { DeviceFlowError, type TokenResponse } from "./oauth-device";

export interface RefreshDeps {
  store: TokenStore;
  profileName: string;
  /** The (possibly legacy) refresh-token key recorded on the profile. */
  refreshTokenRef?: string;
  /** The access token that just 401'd — used to detect another holder's refresh. */
  failedToken: string;
  authUrl: string;
  clientId: string;
  refreshFn: (authUrl: string, refreshToken: string, clientId: string) => Promise<TokenResponse>;
  /** Run the refresh body while holding a cross-process lock. */
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Optional hook to persist the new access-token expiry onto the profile. */
  onExpiry?: (expiresAt: string | undefined) => Promise<void> | void;
}

/**
 * Refresh a profile's access token. Returns the new (or already-rotated) access
 * token, or `null` when the failure looks transient (network / 5xx) and the
 * caller should just surface the original 401. Throws {@link ReauthRequiredError}
 * when re-login is genuinely required (no refresh token, or the server rejected
 * it). Serialized by the injected lock; double-checks the store after acquiring
 * so a waiter never spends an already-rotated token. If the lock itself times
 * out, it does NOT refresh unlocked — it returns a peer's freshly-stored token
 * if one landed, else `null` (surface the original 401) — so contention can
 * never cause two processes to both spend the rotating refresh token.
 */
export async function refreshSession(deps: RefreshDeps): Promise<string | null> {
  try {
    return await deps.withLock(refreshBody(deps));
  } catch (e) {
    if (e instanceof LockTimeoutError) {
      const current = await deps.store.get(deps.profileName);
      return current && current !== deps.failedToken ? current : null;
    }
    throw e;
  }
}

function refreshBody(deps: RefreshDeps): () => Promise<string | null> {
  return async () => {
    // Another holder may have refreshed while we waited for the lock.
    const current = await deps.store.get(deps.profileName);
    if (current && current !== deps.failedToken) return current;

    const candidates = refreshTokenKeyCandidates(deps.profileName, deps.refreshTokenRef);
    let refreshKey: string | undefined;
    let refreshToken: string | undefined;
    for (const key of candidates) {
      const value = await deps.store.get(key);
      if (value) {
        refreshKey = key;
        refreshToken = value;
        break;
      }
    }
    if (!refreshToken || !refreshKey) {
      throw new ReauthRequiredError(deps.profileName, "missing");
    }

    let tokens: TokenResponse;
    try {
      tokens = await deps.refreshFn(deps.authUrl, refreshToken, deps.clientId);
    } catch (e) {
      // 400/401 from the auth server means the refresh token itself is bad
      // (expired / revoked / reuse-detected) → the only fix is to re-login.
      // Other 4xx (408 timeout, 429 rate-limit) and 5xx are transient: under
      // parallel-agent load the token endpoint commonly rate-limits, and forcing
      // a re-login there would be wrong — surface the original 401 and retry.
      if (e instanceof DeviceFlowError && (e.status === 400 || e.status === 401)) {
        throw new ReauthRequiredError(deps.profileName, "rejected");
      }
      return null;
    }

    await deps.store.set(deps.profileName, tokens.access_token);
    await deps.store.set(refreshKey, tokens.refresh_token);
    if (deps.onExpiry) {
      const expiresAt = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : undefined;
      await deps.onExpiry(expiresAt);
    }
    return tokens.access_token;
  };
}

const inFlight = new Map<string, Promise<string | null>>();

/**
 * In-process single-flight: concurrent refreshes for the same profile share one
 * `fn` invocation and resolve to the same result. Complements the cross-process
 * lock so a single process doesn't stampede the lock file.
 */
export function singleFlightRefresh(
  profileName: string,
  fn: () => Promise<string | null>,
): Promise<string | null> {
  const existing = inFlight.get(profileName);
  if (existing) return existing;
  const p = fn().finally(() => inFlight.delete(profileName));
  inFlight.set(profileName, p);
  return p;
}
