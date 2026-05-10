import { loadConfig, saveProfile } from "../config/store";
import { resolveStore } from "../config/token-store";
import { detectKeyType, type KeyType } from "./routing";
import { HttpClient } from "./http";
import { refreshAccessToken } from "../auth/oauth-device";

export interface ResolvedContext {
  client: HttpClient;
  profileName: string;
  api: string;
  token: string;
  tokenType: KeyType;
  /**
   * Tenant ID from the active profile. Populated by `reoclo login` from
   * the `/auth/me` response. May be undefined in env-var-only flows where
   * no profile exists; in that case, tenant-scoped commands should call
   * `/auth/me` themselves or use {@link requireTenantId}.
   */
  tenantId?: string;
}

/**
 * Asserts that {@link ResolvedContext.tenantId} is present and returns it.
 * Throws with exit code 3 if missing — the same code as "not authenticated"
 * since the typical fix is to re-run `reoclo login`.
 */
export function requireTenantId(ctx: ResolvedContext): string {
  if (!ctx.tenantId) {
    const err = new Error(
      "no tenant_id resolved — run 'reoclo login' to populate the profile, or call /auth/me",
    ) as Error & { exitCode: number };
    err.exitCode = 3;
    throw err;
  }
  return ctx.tenantId;
}

export interface BootstrapOptions {
  token?: string; // --token
  profile?: string; // --profile
  api?: string; // --api
}

export async function bootstrap(opts: BootstrapOptions = {}): Promise<ResolvedContext> {
  // Precedence:
  //   1. --token flag
  //   2. REOCLO_AUTOMATION_KEY env (more specific)
  //   3. REOCLO_API_KEY env (generic; routing inferred from prefix)
  //   4. ~/.reoclo/config.json active profile
  const flagToken = opts.token;
  const envAuto = process.env.REOCLO_AUTOMATION_KEY;
  const envGeneric = process.env.REOCLO_API_KEY;

  const cfg = await loadConfig();
  const profileName = opts.profile ?? process.env.REOCLO_PROFILE ?? cfg.active_profile;
  const profile = cfg.profiles[profileName];

  let token: string | undefined;
  if (flagToken) {
    token = flagToken;
  } else if (envAuto) {
    token = envAuto;
  } else if (envGeneric) {
    token = envGeneric;
  } else if (profile) {
    if (profile.token_ref?.startsWith("keyring:")) {
      const store = await resolveStore();
      token = (await store.get(profileName)) ?? undefined;
    } else {
      token = profile.token ?? undefined;
    }
  }

  if (!token) {
    const err = new Error("not authenticated — run 'reoclo login'") as Error & { exitCode: number };
    err.exitCode = 3;
    throw err;
  }

  const api = opts.api ?? process.env.REOCLO_API_URL ?? profile?.api_url ?? "https://api.reoclo.com";

  // Build refresh callback for OAuth profiles
  let refreshTokenCallback: (() => Promise<string | null>) | undefined;
  if (profile?.auth_kind === "oauth" && profile.refresh_token_ref) {
    const capturedProfileName = profileName;
    const capturedProfile = profile;
    refreshTokenCallback = async (): Promise<string | null> => {
      try {
        const store = await resolveStore();
        const refreshTokenKey = capturedProfile.refresh_token_ref!;
        // The ref stored is the keyring key name (e.g. "reoclo-default-refresh")
        // For file store we use the same key directly.
        const storedRefresh = await store.get(refreshTokenKey);
        if (!storedRefresh) return null;

        const authUrl = capturedProfile.oauth_auth_url ?? "https://auth.reoclo.com";
        const clientId = capturedProfile.oauth_client_id ?? "reoclo-cli";
        const newTokens = await refreshAccessToken(authUrl, storedRefresh, clientId);

        // Persist new tokens
        await store.set(capturedProfileName, newTokens.access_token);
        await store.set(refreshTokenKey, newTokens.refresh_token);

        // Update expiry in profile
        const expiresAt = newTokens.expires_in
          ? new Date(Date.now() + newTokens.expires_in * 1000).toISOString()
          : undefined;
        const updatedCfg = await loadConfig();
        const existingProfile = updatedCfg.profiles[capturedProfileName];
        if (existingProfile) {
          await saveProfile(capturedProfileName, {
            ...existingProfile,
            access_token_expires_at: expiresAt,
          });
        }

        return newTokens.access_token;
      } catch {
        return null;
      }
    };
  }

  const client = new HttpClient({
    baseUrl: api,
    token,
    profile: profileName,
    refreshToken: refreshTokenCallback,
  });

  return {
    client,
    profileName,
    api,
    token,
    tokenType: detectKeyType(token),
    tenantId: profile?.tenant_id,
  };
}
