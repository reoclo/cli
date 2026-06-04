// src/commands/login.ts
//
// `reoclo login` is OAuth-only. Tenant integration keys (`rk_t_*`) and the
// generic `REOCLO_API_KEY` env are retired (see .omc/autopilot/spec.md);
// CI/CD continues to use `REOCLO_AUTOMATION_KEY` (`rca_*`) on the bootstrap
// path, which does not go through this command.
import type { Command } from "commander";
import { apiUrl, authUrl, deriveAuthFromApi } from "../lib/urls";
import { loadConfig, saveProfile, setActiveProfile, type ProfileRecord } from "../config/store";
import { resolveCommandProfileWithSource, type ProfileSource } from "../config/profile-resolve";
import { shouldSetActiveProfile, formatLoginSummary } from "./login-summary";
import { clearTenant } from "../completion/cache";
import { resolveStore, refreshTokenKey } from "../config/token-store";
import { HttpClient } from "../client/http";
import type { Me } from "../client/types";
import { fetchCapabilities } from "../client/capabilities";
import { initiateDeviceFlow, pollForToken } from "../auth/oauth-device";
import { openBrowser } from "../ui/open-browser";

type ClientLike = { get: <T>(path: string) => Promise<T> };

export async function buildProfileWithCapabilities(
  client: ClientLike,
  apiUrl: string,
  me: Pick<Me, "tenant_id" | "tenant_slug" | "email">,
  streamsUrl?: string,
): Promise<ProfileRecord> {
  let capabilities: string[] = [];
  try {
    capabilities = await fetchCapabilities(client as unknown as HttpClient);
  } catch {
    // Best-effort: degrade to empty cache. Commands will fail with 403 on the
    // server side; the http-client retry layer will refresh on first 403.
    capabilities = [];
  }
  return {
    api_url: apiUrl,
    streams_url: streamsUrl,
    token_type: "automation",
    tenant_id: me.tenant_id,
    tenant_slug: me.tenant_slug,
    user_email: me.email,
    capabilities,
    capabilities_fetched_at: new Date().toISOString(),
    saved_at: new Date().toISOString(),
  };
}

/** Inputs to the OAuth device-flow runner. `profile` is the already-resolved
 *  target profile name (see resolveCommandProfile). Exported so tests can inject
 *  a runner and assert which profile a `login` invocation resolves. */
export interface LoginFlowOptions {
  profile: string;
  source: ProfileSource;
  api: string;
  auth: string;
  streams?: string;
  keyring?: boolean;
  browser?: boolean;
}

async function runDeviceFlow(opts: LoginFlowOptions): Promise<void> {
  const { profile: profileName, api, auth, streams, keyring, browser } = opts;
  const clientId = "reoclo-cli";
  const scope = "openid tenant.read";

  if (process.stdin.isTTY === false) {
    const e = new Error(
      "OAuth device flow requires an interactive terminal. Run `reoclo login` directly in your shell, or set `REOCLO_AUTOMATION_KEY` for CI.",
    ) as Error & { exitCode: number };
    e.exitCode = 2;
    throw e;
  }

  // 1. Initiate device flow
  const init = await initiateDeviceFlow(auth, clientId, scope);

  // 2. Display instructions
  const isTTY = process.stdout.isTTY;
  const uri = init.verification_uri_complete ?? `${init.verification_uri}?user_code=${init.user_code}`;
  const expiresMins = Math.ceil((init.expires_in ?? 900) / 60);

  if (isTTY) {
    process.stdout.write("\nTo authorize, visit:\n");
    process.stdout.write(`    ${uri}\n\n`);
    process.stdout.write(
      `Or visit ${init.verification_uri} and enter code: ${init.user_code}\n\n`,
    );
  } else {
    process.stdout.write(`Visit ${uri} to authorize (code: ${init.user_code})\n`);
  }

  // 3. Try to open the browser (default on; skip when --no-browser or
  //    when running over SSH / without a display / in CI).
  let opened = false;
  if (browser !== false) {
    opened = openBrowser(uri);
  }
  if (isTTY) {
    if (opened) {
      process.stdout.write("✓ Opened browser. ");
    }
    process.stdout.write(`Waiting for approval... (expires in ${expiresMins} min)\n`);
  }

  // 4. Poll for token
  let dotCount = 0;
  const tokens = await pollForToken(auth, init.device_code, clientId, init.interval, {
    onTick: () => {
      if (isTTY) {
        process.stdout.write(".");
        dotCount++;
        if (dotCount % 60 === 0) process.stdout.write("\n");
      }
    },
  });
  if (isTTY && dotCount > 0) process.stdout.write("\n");

  // 4. Probe /auth/me with the access token to get tenant info
  const probe = new HttpClient({ baseUrl: api, token: tokens.access_token });
  const me = await probe.get<Me>("/auth/me");

  // Capture whether this is the first profile on the machine BEFORE we write
  // anything — drives the Option-A active-profile decision below.
  const hadNoProfiles = Object.keys((await loadConfig()).profiles).length === 0;

  // 5. Save profile
  const baseProfile = await buildProfileWithCapabilities(probe, api, me, streams);
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : undefined;

  const store = await resolveStore({
    requireKeyring: keyring === true,
    forbidKeyring: keyring === false,
  });

  // FileStore.set patches an existing profile entry (token persists inline
  // in config.json), so we have to materialize the profile shell first.
  // Keyring stores don't require this but the extra write is harmless.
  await saveProfile(profileName, baseProfile);

  // Persist the access token via the resolved store (file → config.json,
  // keyring → OS keyring). The refresh token only flows through `store.set`
  // for keyring stores; for FileStore it isn't persisted at all because
  // bootstrap's refresh callback only fires when `refresh_token_ref` is set
  // — file-only users re-run `reoclo login` when the access token expires.
  await store.set(profileName, tokens.access_token);
  if (store.kind === "keyring") {
    await store.set(refreshTokenKey(profileName), tokens.refresh_token);
  }

  const oauthProfile: ProfileRecord = {
    ...baseProfile,
    auth_kind: "oauth",
    oauth_client_id: clientId,
    oauth_auth_url: auth,
    access_token_expires_at: expiresAt,
  };

  if (store.kind === "keyring") {
    oauthProfile.token_ref = `keyring:reoclo-${profileName}`;
    oauthProfile.refresh_token_ref = refreshTokenKey(profileName);
  } else {
    // FileStore persisted the access token inline in config.json on the
    // `store.set` call above; carry it forward so the second saveProfile
    // doesn't clobber it.
    const cfg = await loadConfig();
    const storedToken = cfg.profiles[profileName]?.token;
    if (storedToken) oauthProfile.token = storedToken;
  }

  await saveProfile(profileName, oauthProfile);

  // Option A: set the GLOBAL active profile only on a first/bare login; a
  // scoped login (--profile / $REOCLO_PROFILE) must not change it.
  const setActive = shouldSetActiveProfile({ hadNoProfiles, source: opts.source });
  if (setActive) await setActiveProfile(profileName);

  // Identity (re)established — drop any stale completion cache for this tenant
  // so the next completion re-warms fresh data for the account just signed in.
  clearTenant(me.tenant_id);

  // 6. Success
  console.log(
    formatLoginSummary({
      email: me.email,
      org: me.tenant_slug,
      roles: me.roles ?? [],
      profile: profileName,
      source: opts.source,
      storeKind: store.kind,
      setActive,
    }),
  );
}

export function registerLogin(
  program: Command,
  runFlow: (opts: LoginFlowOptions) => Promise<void> = runDeviceFlow,
): void {
  program
    .command("login")
    .description("sign in via OAuth device flow (browser-based)")
    // NOTE: no command-local `--profile` — it is a global (root-level) flag.
    // Re-declaring it here would shadow the global value (commander routes the
    // typed value to the global option), silently logging into `default`.
    .option("--api <url>", "API base URL", apiUrl())
    .option(
      "--auth <url>",
      "auth service base URL (derived from --api when omitted; falls back to auth.<root-domain>)",
    )
    .option(
      "--streams <url>",
      "Cloudflare-bypass host for terminal WS and large uploads (defaults to streams.reoclo.com for prod, otherwise to --api)",
    )
    .option("--keyring", "require OS keyring storage")
    .option("--no-keyring", "force file storage")
    .option("--no-browser", "do not auto-open the browser during device-flow login")
    .action(
      async (
        opts: {
          api: string;
          auth?: string;
          streams?: string;
          keyring?: boolean;
          browser?: boolean;
        },
        command: Command,
      ) => {
        // Resolve from the global --profile flag (then $REOCLO_PROFILE), with a
        // fresh login defaulting to the "default" profile when neither is set.
        // `source` records which of those produced the name so login can decide
        // whether to touch the global active profile and annotate its feedback.
        const { name: profile, source } = resolveCommandProfileWithSource(command, "default");
        await runFlow({
          profile,
          source,
          api: opts.api,
          auth: opts.auth ?? deriveAuthFromApi(opts.api) ?? authUrl(),
          streams: opts.streams,
          keyring: opts.keyring,
          browser: opts.browser,
        });
      },
    );
}
