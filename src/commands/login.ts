// src/commands/login.ts
import type { Command } from "commander";
import { saveProfile, type ProfileRecord } from "../config/store";
import { resolveStore } from "../config/token-store";
import { HttpClient } from "../client/http";
import { detectKeyType } from "../client/routing";
import type { Me } from "../client/types";
import { fetchCapabilities } from "../client/capabilities";
import { initiateDeviceFlow, pollForToken } from "../auth/oauth-device";

// TODO(future): replace plain readline with hidden-input prompt (termios raw mode).
// Echoing is acceptable today since the primary auth path is `--token` from env.
async function promptToken(msg: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const e = new Error(
      "no API key provided and stdin is not a TTY — pass --token or set REOCLO_API_KEY",
    ) as Error & { exitCode: number };
    e.exitCode = 2;
    throw e;
  }
  // Pass the prompt string into rl.question directly. Splitting it across
  // process.stdout.write + rl.question("") doesn't render reliably in
  // bun-compiled binaries — the buffered write gets swallowed when readline
  // takes over the TTY.
  const { createInterface } = await import("node:readline");
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rl.question(msg, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

type ClientLike = { get: <T>(path: string) => Promise<T> };

export async function buildProfileWithCapabilities(
  client: ClientLike,
  apiUrl: string,
  tokenType: ReturnType<typeof detectKeyType>,
  me: Pick<Me, "tenant_id" | "tenant_slug" | "email">,
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
    token_type: tokenType,
    tenant_id: me.tenant_id,
    tenant_slug: me.tenant_slug,
    user_email: me.email,
    capabilities,
    capabilities_fetched_at: new Date().toISOString(),
    saved_at: new Date().toISOString(),
  };
}

async function runDeviceFlow(opts: {
  profile: string;
  api: string;
  auth: string;
  keyring?: boolean;
}): Promise<void> {
  const { profile: profileName, api, auth, keyring } = opts;
  const clientId = "reoclo-cli";
  const scope = "openid tenant.read";

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
    process.stdout.write(`Waiting for approval... (expires in ${expiresMins} min)\n`);
  } else {
    process.stdout.write(`Visit ${uri} to authorize (code: ${init.user_code})\n`);
  }

  // 3. Poll for token
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

  // 5. Save profile
  const baseProfile = await buildProfileWithCapabilities(probe, api, "tenant", me);
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : undefined;

  const store = await resolveStore({
    requireKeyring: keyring === true,
    forbidKeyring: keyring === false,
  });

  // Store access token under the standard profile key
  await store.set(profileName, tokens.access_token);
  // Store refresh token under a separate key
  const refreshKey = `${profileName}-refresh`;
  await store.set(refreshKey, tokens.refresh_token);

  const oauthProfile: ProfileRecord = {
    ...baseProfile,
    auth_kind: "oauth",
    oauth_client_id: clientId,
    oauth_auth_url: auth,
    access_token_expires_at: expiresAt,
  };

  if (store.kind === "keyring") {
    oauthProfile.token_ref = `keyring:reoclo-${profileName}`;
    oauthProfile.refresh_token_ref = `reoclo-${profileName}-refresh`;
  }

  await saveProfile(profileName, oauthProfile);

  // 6. Success
  console.log(`✓ saved to ${store.kind} — authenticated as ${me.email} (tenant: ${me.tenant_slug})`);
}

export function registerLogin(program: Command): void {
  program
    .command("login")
    .description("authenticate and store credentials")
    .option("--token <key>", "API key (otherwise prompt)")
    .option("--device", "use OAuth 2.1 device flow (browser-based login)")
    .option("--profile <name>", "profile name", "default")
    .option("--api <url>", "API base URL", "https://api.reoclo.com")
    .option("--auth <url>", "auth service base URL", "https://auth.reoclo.com")
    .option("--keyring", "require OS keyring storage")
    .option("--no-keyring", "force file storage")
    .action(
      async (opts: {
        token?: string;
        device?: boolean;
        profile: string;
        api: string;
        auth: string;
        keyring?: boolean;
      }) => {
        // Device flow path
        if (opts.device) {
          await runDeviceFlow({
            profile: opts.profile,
            api: opts.api,
            auth: opts.auth,
            keyring: opts.keyring,
          });
          return;
        }

        // API-key path (existing behavior)
        const token = opts.token ?? (await promptToken("Paste API key: "));

        const probe = new HttpClient({ baseUrl: opts.api, token });
        const me = await probe.get<Me>("/auth/me");

        const profile = await buildProfileWithCapabilities(probe, opts.api, detectKeyType(token), me);
        await saveProfile(opts.profile, { ...profile, auth_kind: "api-key" });

        const store = await resolveStore({
          requireKeyring: opts.keyring === true,
          forbidKeyring: opts.keyring === false,
        });
        await store.set(opts.profile, token);

        if (store.kind === "keyring") {
          await saveProfile(opts.profile, {
            ...profile,
            auth_kind: "api-key",
            token_ref: `keyring:reoclo-${opts.profile}`,
          });
        }

        console.log(`✓ saved to ${store.kind} — authenticated as ${me.email} (tenant: ${me.tenant_slug})`);
      },
    );
}
