// src/auth/tenant-switch.ts
//
// Mint an access token bound to a different organization via the OAuth
// `tenant_switch` grant. Used by bootstrap() for the per-invocation `--org` /
// $REOCLO_ORG / `.reoclo` override, in memory only (there is no persistent
// active org to switch). The mint never mutates stored state itself.

import { sendWithRetry, type FetchLike } from "../client/transport";
import { verboseLogger } from "../client/verbose";
import { NetworkError } from "../client/errors";
import { needsProactiveRefresh, PROACTIVE_SKEW_MS } from "./proactive";

export interface TenantSwitchParams {
  /** OAuth issuer base, e.g. https://auth.reoclo.com (trailing slash tolerated). */
  authUrl: string;
  clientId: string;
  /** The caller's current (org-A) access token. */
  currentAccessToken: string;
  /** Target organization's tenant id. */
  tenantId: string;
}

export class TenantSwitchError extends Error {
  exitCode = 1;
  /** HTTP status of the rejected grant. */
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "TenantSwitchError";
    this.status = status;
  }
}

/** Transport knobs for {@link mintTenantSwitchToken}, injectable for tests. */
export interface TenantSwitchTransport {
  sleep?: (ms: number) => Promise<void>;
  /** Defaults to the process-wide --verbose logger. */
  log?: (line: string) => void;
}

/**
 * POST the `tenant_switch` grant and return the new access token. Throws
 * {@link TenantSwitchError} with the server's `error_description` (when present)
 * on a non-2xx response, and a NetworkError when no response arrives.
 * `fetchImpl` is injectable for tests; it defaults to the global `fetch`.
 *
 * Unlike most POSTs, this one retries a connection that fails before any
 * response: the grant reuses the caller's session and rotates nothing
 * server-side, so a repeat mints one more short-lived token and nothing else.
 */
export async function mintTenantSwitchToken(
  params: TenantSwitchParams,
  fetchImpl: FetchLike = fetch,
  transport: TenantSwitchTransport = {},
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "tenant_switch",
    client_id: params.clientId,
    current_access_token: params.currentAccessToken,
    tenant_id: params.tenantId,
  });
  const res = await sendWithRetry(
    `${params.authUrl.replace(/\/$/, "")}/oauth/token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    },
    {
      retries: 2,
      fetchImpl,
      sleep: transport.sleep,
      log: transport.log ?? verboseLogger(),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    let detail = text;
    try {
      const parsed = JSON.parse(text) as {
        detail?: { error?: string; error_description?: string };
      };
      detail = parsed.detail?.error_description ?? parsed.detail?.error ?? text;
    } catch {
      // non-JSON body — surface as-is
    }
    throw new TenantSwitchError(`tenant_switch failed: ${res.status} — ${detail}`, res.status);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

export interface OrgSwitchRefreshDeps {
  /** The profile's stored access token as of now (other processes rotate it). */
  readProfileToken: () => Promise<string | undefined>;
  /** The stored token's expiry (ISO), when known. */
  readProfileExpiresAt: () => Promise<string | undefined>;
  /** Refresh the profile token (single-flight, locked, persisted). Null on a
   *  transient failure; throws ReauthRequiredError when a login is needed. */
  refreshProfile: (currentToken: string) => Promise<string | null>;
  /** Mint an override-org token from a live profile token. */
  mint: (profileToken: string) => Promise<string>;
  now?: () => number;
}

/**
 * Refresh callback for a token minted for an `--org` override. The grant
 * returns no refresh token, so renewing the org token means minting again from
 * a live profile token: the profile token is refreshed first when it is due,
 * and once more when the mint rejects it with a 400 (expired or revoked
 * early). Returns null on a transient failure, like refreshSession, so the
 * caller surfaces the original 401. A 403 (the org is no longer granted)
 * propagates.
 */
export function orgSwitchRefresh(
  deps: OrgSwitchRefreshDeps,
): (failedToken: string) => Promise<string | null> {
  const now = deps.now ?? Date.now;
  const isTransient = (e: unknown): boolean =>
    e instanceof NetworkError ||
    (e instanceof TenantSwitchError && (e.status === 429 || e.status >= 500));

  return async () => {
    let profileToken = (await deps.readProfileToken()) ?? "";
    if (
      !profileToken ||
      needsProactiveRefresh(await deps.readProfileExpiresAt(), now(), PROACTIVE_SKEW_MS)
    ) {
      const fresh = await deps.refreshProfile(profileToken);
      if (!fresh) return null;
      profileToken = fresh;
    }
    try {
      return await deps.mint(profileToken);
    } catch (e) {
      if (isTransient(e)) return null;
      if (!(e instanceof TenantSwitchError) || e.status !== 400) throw e;
    }
    const fresh = await deps.refreshProfile(profileToken);
    if (!fresh) return null;
    try {
      return await deps.mint(fresh);
    } catch (e) {
      if (isTransient(e)) return null;
      throw e;
    }
  };
}
