import { loadConfig } from "../config/store";
import { resolveStore } from "../config/token-store";
import { detectKeyType, type KeyType } from "./routing";
import { HttpClient } from "./http";

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
    const store = await resolveStore();
    token = (await store.get(profileName)) ?? profile.token ?? undefined;
  }

  if (!token) {
    const err = new Error("not authenticated — run 'reoclo login'") as Error & { exitCode: number };
    err.exitCode = 3;
    throw err;
  }

  const api = opts.api ?? process.env.REOCLO_API_URL ?? profile?.api_url ?? "https://api.reoclo.com";
  const client = new HttpClient({ baseUrl: api, token });
  return {
    client,
    profileName,
    api,
    token,
    tokenType: detectKeyType(token),
    tenantId: profile?.tenant_id,
  };
}
