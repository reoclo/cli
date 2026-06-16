import { join } from "node:path";
import { loadConfig, saveProfile } from "../config/store";
import { resolveStore } from "../config/token-store";
import { cacheDir } from "../config/paths";
import { withFileLock } from "../config/file-lock";
import { refreshSession, singleFlightRefresh } from "../auth/refresh";
import { detectKeyType, type KeyType } from "./routing";
import { HttpClient } from "./http";
import { refreshAccessToken } from "../auth/oauth-device";
import { canonicalApiUrl, canonicalStreamsUrl, authUrl as defaultAuthUrl } from "../lib/urls";
import { resolveProfileName } from "../config/profile-resolve";
import { resolveOrgOverride } from "../config/org-resolve";
import { projectOrgFor, readProjectOrg } from "../config/project-config";
import { setActiveTenantId } from "../completion/cache";
import { mintTenantSwitchToken } from "../auth/tenant-switch";
import type { Me } from "./types";

/**
 * Profile name captured from the global `--profile` flag by index.ts's
 * preAction hook. Most command actions call bootstrap() with no args, so this
 * module-level override is how the global flag reaches them. A command-local
 * `--profile` (e.g. on `login` / `mcp`) still wins via `opts.profile`.
 */
let globalProfileOverride: string | undefined;
export function setGlobalProfileOverride(name: string | undefined): void {
  globalProfileOverride = name;
}

/**
 * Organization slug captured from the global `--org` flag by index.ts's
 * preAction hook — the per-invocation org override counterpart to
 * {@link setGlobalProfileOverride}. Reaches bootstrap() the same way.
 */
let globalOrgOverride: string | undefined;
export function setGlobalOrgOverride(slug: string | undefined): void {
  globalOrgOverride = slug;
}

export interface ResolvedContext {
  client: HttpClient;
  profileName: string;
  api: string;
  /**
   * Host for Cloudflare-bypass traffic (interactive terminal WS, large
   * uploads, SSE streams). Defaults to `streams.reoclo.com` for the
   * production API host, and to the same value as {@link api} for any
   * dev / staging / localhost configuration — so local CLI development
   * "just works" against a single backend without an extra flag.
   */
  streamsUrl: string;
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

// Canonical deployment URLs, derived from REOCLO_ROOT_DOMAIN only — NOT the
// per-invocation REOCLO_API_URL / REOCLO_STREAMS_URL overrides (those are
// applied explicitly in the precedence chains below). Keeps the streams-host
// comparison base stable even when --api / REOCLO_API_URL repoints the API.
const PROD_API_URL = canonicalApiUrl();
const PROD_STREAMS_URL = canonicalStreamsUrl();

/**
 * Derive a default streams URL from the API URL. Production API gets the
 * dedicated CF-bypass host; everything else (dev, staging, localhost,
 * custom) gets the API host itself so a single backend serves both.
 */
export function defaultStreamsUrl(apiUrl: string): string {
  const trimmed = apiUrl.replace(/\/$/, "");
  if (trimmed === PROD_API_URL) return PROD_STREAMS_URL;
  return trimmed;
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
  org?: string; // --org (per-invocation organization override)
  api?: string; // --api
  streams?: string; // --streams
  /** When true, the HttpClient will send X-Reoclo-Source: mcp on every request. */
  mcpSource?: boolean;
}

export async function bootstrap(opts: BootstrapOptions = {}): Promise<ResolvedContext> {
  // Precedence:
  //   1. --token flag                (programmatic; used by automation harness + tests)
  //   2. REOCLO_AUTOMATION_KEY env   (CI/CD with rca_* automation keys)
  //   3. ~/.reoclo/config.json active profile (populated by `reoclo login` OAuth)
  //
  // The legacy `REOCLO_API_KEY` env (tenant integration keys, rk_t_*) is no
  // longer honored — those keys are retired in favour of OAuth device flow.
  const flagToken = opts.token;
  const envAuto = process.env.REOCLO_AUTOMATION_KEY;

  const cfg = await loadConfig();
  const profileName = resolveProfileName({
    flagProfile: opts.profile ?? globalProfileOverride,
    envProfile: process.env.REOCLO_PROFILE,
    activeProfile: cfg.active_profile,
  });
  const profile = cfg.profiles[profileName];

  let token: string | undefined;
  if (flagToken) {
    token = flagToken;
  } else if (envAuto) {
    token = envAuto;
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

  const api = opts.api ?? process.env.REOCLO_API_URL ?? profile?.api_url ?? PROD_API_URL;
  const streamsUrl =
    opts.streams ??
    process.env.REOCLO_STREAMS_URL ??
    profile?.streams_url ??
    defaultStreamsUrl(api);

  // Build the OAuth refresh callback up front so it's available to BOTH the
  // org-override probe below and the final client. It refreshes + persists the
  // PROFILE's token; the final client only attaches it when we haven't minted a
  // separate org-override token (see suppressRefresh).
  let profileRefreshCallback: ((failedToken: string) => Promise<string | null>) | undefined;
  if (profile?.auth_kind === "oauth" && profile.refresh_token_ref) {
    const capturedProfileName = profileName;
    const capturedProfile = profile;
    const lockPath = join(cacheDir(), "locks", `${capturedProfileName}.refresh.lock`);
    // Refresh is serialized cross-process (file lock) and in-process
    // (single-flight) so concurrent agents/commands never both spend a rotating
    // refresh token. refreshSession resolves the key, persists rotated tokens,
    // returns null on transient failures, and throws ReauthRequiredError when a
    // re-login is genuinely required (which HttpClient surfaces to the user).
    profileRefreshCallback = (failedToken: string): Promise<string | null> =>
      singleFlightRefresh(capturedProfileName, async () => {
        const store = await resolveStore();
        return refreshSession({
          store,
          profileName: capturedProfileName,
          refreshTokenRef: capturedProfile.refresh_token_ref ?? undefined,
          failedToken,
          authUrl: capturedProfile.oauth_auth_url ?? defaultAuthUrl(),
          clientId: capturedProfile.oauth_client_id ?? "reoclo-cli",
          refreshFn: refreshAccessToken,
          withLock: (fn) => withFileLock(lockPath, fn),
          onExpiry: async (expiresAt) => {
            const updatedCfg = await loadConfig();
            const existingProfile = updatedCfg.profiles[capturedProfileName];
            if (existingProfile) {
              await saveProfile(capturedProfileName, {
                ...existingProfile,
                access_token_expires_at: expiresAt,
              });
            }
          },
        });
      });
  }

  // Per-invocation organization override (`--org` / $REOCLO_ORG / `.reoclo`).
  // Resolves the target org slug -> tenant_id via /auth/me, then mints a token
  // scoped to it through the OAuth tenant_switch grant — in-memory only, never
  // persisted, so parallel agents / CI never clobber the stored active org. When
  // the override already equals the profile's org it's a no-op (no extra network
  // calls). The `.reoclo` project file is consulted only for OAuth profiles (and
  // ranks below the flag/env), so it stays inert under automation-key CI.
  let tenantId = profile?.tenant_id;
  let effectiveToken = token;
  let suppressRefresh = false;
  const orgOverride = resolveOrgOverride({
    flagOrg: opts.org ?? globalOrgOverride,
    envOrg: process.env.REOCLO_ORG,
    projectOrg: projectOrgFor(profile?.auth_kind, () => readProjectOrg()),
  });
  if (orgOverride && orgOverride !== profile?.tenant_slug) {
    if (!profile || profile.auth_kind !== "oauth") {
      const err = new Error(
        "--org / $REOCLO_ORG requires an OAuth profile — run 'reoclo login'",
      ) as Error & { exitCode: number };
      err.exitCode = 4;
      throw err;
    }
    // The probe reuses the profile's refresh callback so a stale-but-refreshable
    // token transparently refreshes here, matching the non-override path.
    const probe = new HttpClient({
      baseUrl: api,
      token,
      profile: profileName,
      refreshToken: profileRefreshCallback,
    });
    const me = await probe.get<Me>("/auth/me");
    const target = (me.memberships ?? []).find((m) => m.tenant_slug === orgOverride);
    if (!target) {
      const granted = (me.memberships ?? []).map((m) => m.tenant_slug).join(", ") || "(none)";
      const err = new Error(
        `org '${orgOverride}' is not in your granted organizations.\n` +
          `Granted: ${granted}\nRe-run 'reoclo login' to expand the consent.`,
      ) as Error & { exitCode: number };
      err.exitCode = 5;
      throw err;
    }
    tenantId = target.tenant_id;
    // Only mint a fresh token when actually crossing org boundaries — a
    // tenant_switch back to the profile's own org is unnecessary.
    if (target.tenant_id !== profile.tenant_id) {
      effectiveToken = await mintTenantSwitchToken({
        authUrl: profile.oauth_auth_url ?? defaultAuthUrl(),
        clientId: profile.oauth_client_id ?? "reoclo-cli",
        currentAccessToken: token,
        tenantId: target.tenant_id,
      });
      // The minted token is fresh and bound to the override org; a 401-driven
      // refresh would re-bind to the profile's default org, so suppress it.
      suppressRefresh = true;
    }
  }

  // Scope the completion cache to the resolved tenant (honors --org override),
  // so opportunistic cache writes from this command land under the authorised
  // account — never leaking into another account's completions.
  setActiveTenantId(tenantId);

  const client = new HttpClient({
    baseUrl: api,
    token: effectiveToken,
    profile: profileName,
    refreshToken: suppressRefresh ? undefined : profileRefreshCallback,
    mcpSource: opts.mcpSource,
  });

  return {
    client,
    profileName,
    api,
    streamsUrl,
    token: effectiveToken,
    tokenType: detectKeyType(effectiveToken),
    tenantId,
  };
}
