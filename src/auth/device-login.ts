// src/auth/device-login.ts
//
// The OAuth device flow as a library: ask for a code, wait for approval, save
// the profile. `reoclo login` prints the code to a terminal; the tunnel daemon
// passes it to the desktop app. Neither duplicates the flow.

import { loadConfig, saveProfile, setActiveProfile, type ProfileRecord } from "../config/store";
import type { ProfileSource } from "../config/profile-resolve";
import { shouldSetActiveProfile } from "../commands/login-summary";
import { clearProfile } from "../completion/cache";
import { resolveStore, refreshTokenKey } from "../config/token-store";
import { HttpClient } from "../client/http";
import type { Me } from "../client/types";
import { fetchCapabilities } from "../client/capabilities";
import { initiateDeviceFlow, pollForToken, type DeviceInitResponse } from "./oauth-device";

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
 *  target profile name (see resolveCommandProfileWithSource). Exported so tests can inject
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

export interface DeviceLoginHooks {
  /** Called once with the code and the URL to approve it at, before polling starts. */
  onCode(init: DeviceInitResponse, uri: string): void;
  /** Called before every poll. */
  onTick?(): void;
  /** Called once approval arrives, before the profile is saved. */
  onApproved?(): void;
  abortSignal?: AbortSignal;
}

export interface DeviceLoginResult {
  me: Me;
  storeKind: Awaited<ReturnType<typeof resolveStore>>["kind"];
  setActive: boolean;
}

export interface DeviceLoginTransport {
  initiate: typeof initiateDeviceFlow;
  poll: typeof pollForToken;
}

const CLIENT_ID = "reoclo-cli";
const SCOPE = "openid tenant.read";

export async function deviceLogin(
  opts: LoginFlowOptions,
  hooks: DeviceLoginHooks,
  transport: DeviceLoginTransport = { initiate: initiateDeviceFlow, poll: pollForToken },
): Promise<DeviceLoginResult> {
  const { profile: profileName, api, auth, streams, keyring } = opts;

  const init = await transport.initiate(auth, CLIENT_ID, SCOPE);
  const uri = init.verification_uri_complete ?? `${init.verification_uri}?user_code=${init.user_code}`;
  hooks.onCode(init, uri);

  const tokens = await transport.poll(auth, init.device_code, CLIENT_ID, init.interval, {
    onTick: () => hooks.onTick?.(),
    abortSignal: hooks.abortSignal,
  });
  hooks.onApproved?.();

  // Probe /auth/me with the access token to get tenant info
  const probe = new HttpClient({ baseUrl: api, token: tokens.access_token });
  const me = await probe.get<Me>("/auth/me");

  // Capture whether this is the first profile on the machine BEFORE we write
  // anything: drives the Option-A active-profile decision below.
  const hadNoProfiles = Object.keys((await loadConfig()).profiles).length === 0;

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
  // keyring → OS keyring). The refresh token goes to the keyring under
  // `refresh_token_ref`, or inline as `refresh_token` in the 0600 config.json
  // below. Without it a host with no keyring needed a new login every hour.
  await store.set(profileName, tokens.access_token);
  if (store.kind === "keyring") {
    await store.set(refreshTokenKey(profileName), tokens.refresh_token);
  }

  const oauthProfile: ProfileRecord = {
    ...baseProfile,
    auth_kind: "oauth",
    oauth_client_id: CLIENT_ID,
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
    oauthProfile.refresh_token = tokens.refresh_token;
  }

  await saveProfile(profileName, oauthProfile);

  // Option A: set the GLOBAL active profile only on a first/bare login; a
  // scoped login (--profile / $REOCLO_PROFILE) must not change it.
  const setActive = shouldSetActiveProfile({ hadNoProfiles, source: opts.source });
  if (setActive) await setActiveProfile(profileName);

  // Identity (re)established: drop this profile's completion cache (every org
  // bucket) so the next completion re-warms fresh data for the account just
  // signed in.
  clearProfile(profileName);

  return { me, storeKind: store.kind, setActive };
}
