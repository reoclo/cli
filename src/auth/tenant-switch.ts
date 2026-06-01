// src/auth/tenant-switch.ts
//
// Mint an access token bound to a different organization via the OAuth
// `tenant_switch` grant. Shared by `reoclo org use` (which persists the result)
// and the per-invocation `--org` / $REOCLO_ORG override in bootstrap() (which
// uses it in-memory only). The mint never mutates stored state itself.

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
  constructor(message: string) {
    super(message);
    this.name = "TenantSwitchError";
  }
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * POST the `tenant_switch` grant and return the new access token. Throws
 * {@link TenantSwitchError} with the server's `error_description` (when present)
 * on a non-2xx response. `fetchImpl` is injectable for tests; it defaults to
 * the global `fetch`.
 */
export async function mintTenantSwitchToken(
  params: TenantSwitchParams,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "tenant_switch",
    client_id: params.clientId,
    current_access_token: params.currentAccessToken,
    tenant_id: params.tenantId,
  });
  const res = await fetchImpl(`${params.authUrl.replace(/\/$/, "")}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
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
    throw new TenantSwitchError(`tenant_switch failed: ${res.status} — ${detail}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}
