// src/commands/connect-omega-mcp.ts
//
// Internal-only command. Hidden from `reoclo --help`. Mints an OAuth token
// pair scoped to the platform-admin `omega-mcp` surface and writes it to
// ${configDir()}/omega-mcp.json so the omega-mcp Docker container can mount
// it read-write and self-refresh.
//
// Companion to feat(api) 1.48.0 — the `reoclo-omega-mcp` OAuth client and
// `mcp:omega` scope live on the API; this command is just the local mint.

import type { Command } from "commander";
import { apiUrl, authUrl, deriveAuthFromApi } from "../lib/urls";
import { HttpClient } from "../client/http";
import type { Me } from "../client/types";
import { initiateDeviceFlow, pollForToken } from "../auth/oauth-device";
import { openBrowser } from "../ui/open-browser";
import {
  omegaMcpTokenPath,
  writeOmegaMcpTokens,
  type OmegaMcpTokenFile,
} from "../auth/omega-mcp-store";

const CLIENT_ID = "reoclo-omega-mcp";
const SCOPE = "mcp:omega";

async function runConnectOmegaMcp(opts: {
  api: string;
  auth: string;
  browser?: boolean;
}): Promise<void> {
  const { api, auth, browser } = opts;

  if (process.stdin.isTTY === false) {
    const e = new Error(
      "OAuth device flow requires an interactive terminal. Run `reoclo connect-omega-mcp` directly in your shell.",
    ) as Error & { exitCode: number };
    e.exitCode = 2;
    throw e;
  }

  const init = await initiateDeviceFlow(auth, CLIENT_ID, SCOPE);

  const isTTY = process.stdout.isTTY;
  const uri =
    init.verification_uri_complete ?? `${init.verification_uri}?user_code=${init.user_code}`;
  const expiresMins = Math.ceil((init.expires_in ?? 900) / 60);

  if (isTTY) {
    process.stdout.write("\nTo authorize omega-mcp, visit:\n");
    process.stdout.write(`    ${uri}\n\n`);
    process.stdout.write(
      `Or visit ${init.verification_uri} and enter code: ${init.user_code}\n\n`,
    );
  } else {
    process.stdout.write(`Visit ${uri} to authorize (code: ${init.user_code})\n`);
  }

  let opened = false;
  if (browser !== false) {
    opened = openBrowser(uri);
  }
  if (isTTY) {
    if (opened) process.stdout.write("✓ Opened browser. ");
    process.stdout.write(`Waiting for approval... (expires in ${expiresMins} min)\n`);
  }

  let dotCount = 0;
  const tokens = await pollForToken(auth, init.device_code, CLIENT_ID, init.interval, {
    onTick: () => {
      if (isTTY) {
        process.stdout.write(".");
        dotCount++;
        if (dotCount % 60 === 0) process.stdout.write("\n");
      }
    },
  });
  if (isTTY && dotCount > 0) process.stdout.write("\n");

  // Sanity-check the token has the scope we asked for. If the server didn't
  // mint mcp:omega (mis-configured client, scope rejected, etc.) we bail now
  // rather than silently writing a token that omega-mcp will refuse to start
  // with — saves the user a confusing failure on the next leg.
  const grantedScopes = (tokens.scope ?? "").split(/\s+/).filter(Boolean);
  if (!grantedScopes.includes(SCOPE)) {
    const e = new Error(
      `server did not grant required scope '${SCOPE}' (got: '${tokens.scope || "<empty>"}')`,
    ) as Error & { exitCode: number };
    e.exitCode = 1;
    throw e;
  }

  // Probe /auth/me so the user sees the identity they authorized as.
  const probe = new HttpClient({ baseUrl: api, token: tokens.access_token });
  const me = await probe.get<Me>("/auth/me");

  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : new Date(Date.now() + 3600 * 1000).toISOString();

  // omega-mcp's API routes live under the `/mcp` prefix on the gateway
  // (e.g. /mcp/auth/me/acl). Bake the prefix into the stored api_url so
  // omega-mcp's client can concatenate request paths without knowing the
  // prefix exists. If --api was passed with /mcp already, don't double it.
  const apiBase = api.replace(/\/+$/, "");
  const apiWithPrefix = apiBase.endsWith("/mcp") ? apiBase : `${apiBase}/mcp`;

  const tokenFile: OmegaMcpTokenFile = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: expiresAt,
    api_url: apiWithPrefix,
    auth_url: auth,
    client_id: CLIENT_ID,
    scope: SCOPE,
  };
  await writeOmegaMcpTokens(tokenFile);

  const path = omegaMcpTokenPath();
  console.log(`✓ omega-mcp connected as ${me.email} (organization: ${me.tenant_slug})`);
  console.log(`  token file: ${path}`);
  console.log("");
  console.log("Add this MCP server to your Claude Code config:");
  console.log("");
  console.log("  command: /usr/local/bin/docker");
  console.log("  args:");
  console.log("    - run");
  console.log("    - --rm");
  console.log("    - -i");
  console.log(`    - -v`);
  console.log(`    - ${path}:/auth/token.json`);
  console.log("    - ghcr.io/reoclo/omega-mcp:latest");
}

export function registerConnectOmegaMcp(program: Command): void {
  // Hidden — internal use only, not advertised in `reoclo --help`.
  // The command IS the auth flow, so it must skip the auth preAction
  // (see PASSTHROUGH_COMMANDS in index.ts).
  program
    .command("connect-omega-mcp", { hidden: true })
    .description("mint an OAuth token scoped to omega-mcp (internal)")
    .option("--api <url>", "API base URL", apiUrl())
    .option(
      "--auth <url>",
      "auth service base URL (derived from --api when omitted; falls back to auth.<root-domain>)",
    )
    .option("--no-browser", "do not auto-open the browser during device-flow login")
    .action(async (opts: { api: string; auth?: string; browser?: boolean }) => {
      await runConnectOmegaMcp({
        api: opts.api,
        auth: opts.auth ?? deriveAuthFromApi(opts.api) ?? authUrl(),
        browser: opts.browser,
      });
    });
}
