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
import { resolveOrgOverride, orgSelectionError } from "../config/org-resolve";
import { projectOrgFor, readProjectConfig } from "../config/project-config";
import { setActiveTenantId } from "../completion/cache";
import { mintTenantSwitchToken } from "../auth/tenant-switch";
import { applyProactiveRefresh, PROACTIVE_SKEW_MS } from "../auth/proactive";
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
  /** Profile access-token expiry (ISO), when known: used by the MCP server to
   *  schedule proactive refreshes. */
  accessTokenExpiresAt?: string;
  /** Refresh the PROFILE token (single-flight + locked + persisted), returning
   *  the fresh token or null on a transient failure. Absent for non-OAuth
   *  credentials and when an org-override token was minted (that token is fresh
   *  and must not be refreshed back to the profile's org). */
  refresh?: (currentToken: string) => Promise<string | null>;
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
  /** When true (default) and the credential is an OAuth profile, a command with
   *  no resolved org override (--org / $REOCLO_ORG / .reoclo) fails with exit 4.
   *  Identity-only callers (whoami, org ls/current, init, completion warm, the
   *  preAction probe) pass false. */
  orgRequired?: boolean;
  api?: string; // --api
  streams?: string; // --streams
  /** When true, the HttpClient will send X-Reoclo-Source: mcp on every request. */
  mcpSource?: boolean;
  /** When true, the `.reoclo` project-file org is NOT read into the
   *  per-invocation org override. `init` passes this: it is the command that
   *  rewrites the binding, so a stale or ungranted `.reoclo` org must not block
   *  it. `--org` / `$REOCLO_ORG` are unaffected. */
  ignoreProjectOrg?: boolean;
}

/**
 * True when an ambient, env-provided credential (`REOCLO_MACHINE_TOKEN` or
 * `REOCLO_AUTOMATION_KEY`) is set. Both are opaque, tenant/org-bound
 * credentials with no profile of their own, so every place that decides
 * whether it's safe to read ambient local state on their behalf — `.reoclo`
 * project config, an ambient stored profile, the OAuth refresh cache, the
 * auto-update advisory notices — must treat them identically. `bootstrap()`
 * itself computes this inline (it needs the actual token values, not just the
 * boolean), but every OTHER call site that only needs the yes/no answer
 * (index.ts's capability-gating + advisory hooks, update-check.ts's CI
 * suppression) must go through this helper instead of re-deriving the
 * predicate by hand — a bare `REOCLO_AUTOMATION_KEY` check at one of those
 * sites is exactly the drift bug this helper exists to prevent.
 */
export function isEnvCredential(): boolean {
  return Boolean(process.env.REOCLO_MACHINE_TOKEN || process.env.REOCLO_AUTOMATION_KEY);
}

export async function bootstrap(opts: BootstrapOptions = {}): Promise<ResolvedContext> {
  // Precedence:
  //   1. --token flag                (programmatic; used by automation harness + tests)
  //   2. REOCLO_MACHINE_TOKEN env    (agent/machine-user credential, rk_m_*: org-scoped,
  //                                   full /mcp surface, no expiry — the more specific
  //                                   of the two env credentials)
  //   3. REOCLO_AUTOMATION_KEY env   (CI/CD with rca_* automation keys)
  //   4. ~/.reoclo/config.json active profile (populated by `reoclo login` OAuth)
  //
  // The legacy `REOCLO_API_KEY` env (tenant integration keys, rk_t_*) is no
  // longer honored — those keys are retired in favour of OAuth device flow.
  // If it's set and no credential resolves below, a stderr hint points the
  // caller at REOCLO_AUTOMATION_KEY instead.
  const flagToken = opts.token;
  const envMachine = process.env.REOCLO_MACHINE_TOKEN;
  const envAuto = process.env.REOCLO_AUTOMATION_KEY;
  // Both env vars are opaque, ambient, env-provided credentials with no profile
  // of their own — everywhere below that gates .reoclo/profile/refresh behavior
  // on "is an env credential in use", either one must trigger it identically.
  // Only the token-selection precedence and any user-facing message need to
  // tell the two apart.
  const envCredential = envMachine ?? envAuto;

  // `.reoclo` is ambient, committed repo config: consult it only for interactive
  // (non-env-credential) use, so under automation-key/machine-token CI it's
  // never even read and a malformed file never throws. It can pin the profile
  // (below --profile / $REOCLO_PROFILE) and, further down, the org.
  const projectConfig = envCredential ? null : readProjectConfig();

  const cfg = await loadConfig();
  const profileName = resolveProfileName({
    flagProfile: opts.profile ?? globalProfileOverride,
    envProfile: process.env.REOCLO_PROFILE,
    projectProfile: projectConfig?.profile,
    activeProfile: cfg.active_profile,
  });
  const profile = cfg.profiles[profileName];

  // Fail loud when `.reoclo` pins a profile that doesn't exist locally, rather
  // than surfacing a confusing "not authenticated" below.
  if (projectConfig?.profile && profileName === projectConfig.profile && !profile) {
    const err = new Error(
      `.reoclo selects profile '${projectConfig.profile}', but it doesn't exist — ` +
        `run 'reoclo login --profile ${projectConfig.profile}'`,
    ) as Error & { exitCode: number };
    err.exitCode = 3;
    throw err;
  }

  let token: string | undefined;
  if (flagToken) {
    token = flagToken;
  } else if (envMachine) {
    token = envMachine;
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
    if (process.env.REOCLO_API_KEY) {
      process.stderr.write(
        "REOCLO_API_KEY is not read by the CLI; set REOCLO_AUTOMATION_KEY (CI) or " +
          "REOCLO_MACHINE_TOKEN (agents) instead.\n",
      );
    }
    const err = new Error("not authenticated — run 'reoclo login'") as Error & { exitCode: number };
    err.exitCode = 3;
    throw err;
  }

  // An automation key or machine token is tenant-bound and carries no profile
  // of its own. Under either, an *ambient* profile (the saved `active_profile`)
  // must not redirect CI/agent traffic to whatever host it happens to point
  // at. `.reoclo` is suppressed above for the same reason.
  //
  // A profile the caller *named* is a different thing, and must still apply.
  // `reoclo --profile staging run -- ./verify.sh` with a staging key has to
  // reach staging: nulling it here would send that key to production, which
  // both fails with an opaque 401 and sends the key to a host the caller never
  // asked for. That matters most for a self-hosted install, where the default
  // is Reoclo's own SaaS endpoint.
  //
  // `REOCLO_API_URL` / `REOCLO_STREAMS_URL` remain the only other override. No
  // CLI flag can do it, because `--api` is command-local to `login` and
  // `connect-omega-mcp`, and an automation key/machine token can run neither.
  const profileWasNamed = Boolean(
    opts.profile ?? globalProfileOverride ?? process.env.REOCLO_PROFILE,
  );
  const profileEndpoints = envCredential && !profileWasNamed ? null : profile;

  const api = opts.api ?? process.env.REOCLO_API_URL ?? profileEndpoints?.api_url ?? PROD_API_URL;
  const streamsUrl =
    opts.streams ??
    process.env.REOCLO_STREAMS_URL ??
    profileEndpoints?.streams_url ??
    defaultStreamsUrl(api);

  // Build the OAuth refresh callback up front so it's available to BOTH the
  // org-override probe below and the final client. It refreshes + persists the
  // PROFILE's token; the final client only attaches it when we haven't minted a
  // separate org-override token (see suppressRefresh).
  //
  // profileRefreshCallback refreshes the PROFILE's OAuth token, so it must be
  // suppressed when a --token / automation key / machine token is the
  // credential actually in use (they outrank the profile token in the
  // precedence chain above). Otherwise the proactive or reactive refresh would
  // swap in an ambient profile's token behind the caller's back: wrong
  // credential, possibly a different tenant.
  let profileRefreshCallback: ((failedToken: string) => Promise<string | null>) | undefined;
  if (!flagToken && !envCredential && profile?.auth_kind === "oauth" && profile.refresh_token_ref) {
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
          tenantId: capturedProfile.tenant_id,
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

  // Proactive refresh: refresh the profile token BEFORE issuing any request (the
  // org-override probe or the final client) when it's within the skew of
  // expiry, so a long-idle session doesn't eat a 401 round-trip. Reuses the
  // profile's single-flight + locked refresh (never double-spends the rotating
  // token).
  token = await applyProactiveRefresh(
    token, profile?.access_token_expires_at, profileRefreshCallback, Date.now(), PROACTIVE_SKEW_MS,
  );
  effectiveToken = token;

  const orgOverride = resolveOrgOverride({
    flagOrg: opts.org ?? globalOrgOverride,
    envOrg: process.env.REOCLO_ORG,
    projectOrg: opts.ignoreProjectOrg
      ? undefined
      : projectOrgFor(profile?.auth_kind, () => projectConfig?.org ?? null),
  });
  const orgErr = orgSelectionError({
    orgRequired: opts.orgRequired ?? true,
    orgOverride,
    // `profile.auth_kind` reflects whatever profile happens to be on disk, not
    // necessarily the credential actually in use — --token / REOCLO_MACHINE_TOKEN
    // / REOCLO_AUTOMATION_KEY all outrank the profile token (see the precedence
    // chain above). Those credentials are single-tenant, or org-scoped on their
    // own, so when any is set, the profile's auth_kind must not trigger the
    // OAuth-only org requirement.
    authKind: flagToken || envCredential ? undefined : profile?.auth_kind,
  });
  if (orgErr) throw orgErr;
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
      profile: envCredential ? undefined : profileName,
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
    profile: envCredential ? undefined : profileName,
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
    accessTokenExpiresAt: profile?.access_token_expires_at,
    refresh: suppressRefresh ? undefined : profileRefreshCallback,
  };
}
