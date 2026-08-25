// src/commands/mcp.ts
import type { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bootstrap, requireTenantId, type ResolvedContext } from "../client/bootstrap";
import { createMcpServer } from "../mcp/server";
import type { McpRegistrationContext } from "../mcp/tools/context";
import type { HttpClient } from "../client/http";
import { startTokenRefreshLoop, PROACTIVE_SKEW_MS } from "../auth/proactive";
import { loadConfig } from "../config/store";

export interface McpBootstrapResult {
  ctx: ResolvedContext;
  tenantId: string;
}

/**
 * Bootstrap + resolve the tenant the MCP server registers tools under.
 *
 * `ctx.tenantId` alone is only the ambient PROFILE's tenant — undefined for
 * an env credential (REOCLO_MACHINE_TOKEN / REOCLO_AUTOMATION_KEY), which has
 * no profile of its own (see bootstrap.ts's `requireTenantId` doc for the
 * cross-org leak this guards against). Every MCP tool module reads
 * `ctx.tenantId` raw and no-ops when it's undefined, so passing it straight
 * through here used to register just the one tenant-optional tool (whoami)
 * under an env credential — silently, no error, no stderr.
 *
 * `requireTenantId` instead resolves the credential's OWN tenant (one
 * `/auth/me`, memoized on `ctx`; free when a profile already carries a
 * tenant_id) and throws an honest exit 3 for the genuinely tenantless case,
 * instead of a silently near-empty tool list.
 *
 * Exported so tests can drive this exact resolution path without also
 * spinning up the stdio transport / background refresh loop that the rest of
 * the action performs. Resolved up front — before the server starts serving —
 * so a resolution failure surfaces immediately, not from inside a request
 * handler.
 */
export async function resolveMcpBootstrap(): Promise<McpBootstrapResult> {
  const ctx = await bootstrap({ mcpSource: true });
  const tenantId = await requireTenantId(ctx);
  return { ctx, tenantId };
}

/**
 * The CLI host's tool context. The org is fixed for the life of the process:
 * `bootstrap()` has already applied `--org` / $REOCLO_ORG / `.reoclo` (minting
 * an in-memory tenant_switch token when it differs from the login org) and
 * rejected an OAuth profile with no binding (exit 4). So no `organization`
 * argument is exposed, and any value a client passes anyway is ignored.
 */
export function buildCliMcpContext(client: HttpClient, tenantId: string): McpRegistrationContext {
  return {
    client,
    orgParam: {},
    resolveOrg: async () => ({ tenantId, client }),
  };
}

export function registerMcp(program: Command): void {
  program
    .command("mcp")
    // No command-local `--profile` — the global flag is honored by bootstrap()
    // (which reads the captured global override, then $REOCLO_PROFILE, then the
    // active profile).
    .description("start the stdio MCP server")
    .action(async () => {
      const { ctx, tenantId } = await resolveMcpBootstrap();

      // stdout is sacred for MCP protocol framing — redirect any incidental
      // console.log to stderr while the server is running.
      const origLog = console.log;
      console.log = console.error;

      // Keep the OAuth token fresh for the life of this long-lived server.
      // `ctx.refresh` is only set for genuine OAuth profiles (undefined for
      // --token / automation-key credentials), so this correctly no-ops for
      // those. Read the expiry fresh from config rather than trusting
      // `ctx.accessTokenExpiresAt`, because this same bootstrap() call may
      // already have performed a proactive refresh, and the in-memory profile
      // snapshot bootstrap captured isn't re-read. Using the stale value would
      // make the loop redundantly refresh once more right at startup.
      let stopRefresh: (() => void) | undefined;
      if (ctx.refresh) {
        const initialExpiresAt = (await loadConfig()).profiles[ctx.profileName]?.access_token_expires_at;
        stopRefresh = startTokenRefreshLoop({
          refresh: ctx.refresh,
          // ctx.token is only the bootstrap-time snapshot used to seed the
          // loop. The loop tracks the live token itself from here on, updating
          // it from each successful refresh, so it never drifts from what
          // onToken pushes into the client.
          initialToken: ctx.token,
          onToken: (t) => ctx.client.updateToken(t),
          getExpiresAt: async () => (await loadConfig()).profiles[ctx.profileName]?.access_token_expires_at,
          initialExpiresAt,
          skewMs: PROACTIVE_SKEW_MS,
          now: () => Date.now(),
          setTimer: (fn, ms) => {
            const h = setTimeout(fn, ms);
            (h as unknown as { unref?: () => void }).unref?.();
            return h;
          },
          clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        });
      }

      try {
        const server = createMcpServer(buildCliMcpContext(ctx.client, tenantId));
        await server.connect(new StdioServerTransport());
      } finally {
        stopRefresh?.();
        console.log = origLog;
      }
    });
}
