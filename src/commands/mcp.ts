// src/commands/mcp.ts
import type { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { bootstrap, requireTenantId, type ResolvedContext } from "../client/bootstrap";
import { createMcpServer } from "../mcp/server";
import type { McpRegistrationContext, OrgScope } from "../mcp/tools/context";
import type { HttpClient } from "../client/http";
import { startTokenRefreshLoop, PROACTIVE_SKEW_MS } from "../auth/proactive";
import { loadConfig } from "../config/store";
import { jwtExpiresAt } from "../auth/renew";

export interface McpBootstrapResult {
  ctx: ResolvedContext;
  /** The org every tool acts on, or undefined when nothing binds one and each call names it. */
  tenantId: string | undefined;
}

const UNBOUND_ORG_DESCRIPTION =
  "Organization slug. Required: nothing binds this server to one. Call whoami to list the organizations you can act on.";
const MISSING_ORG_MESSAGE =
  "organization is required: this reoclo mcp is not bound to one. Call whoami to list your organizations, or start reoclo mcp with --org <slug>.";

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
 * An OAuth profile with no `--org` / $REOCLO_ORG / `.reoclo` has no org at all
 * (there is no default org). The server starts anyway, and every tool takes an
 * `organization` argument instead (see {@link buildUnboundMcpContext}): failing
 * here would only show the MCP client a dropped connection.
 *
 * Exported so tests can drive this exact resolution path without also
 * spinning up the stdio transport / background refresh loop that the rest of
 * the action performs. Resolved up front — before the server starts serving —
 * so a resolution failure surfaces immediately, not from inside a request
 * handler.
 */
export async function resolveMcpBootstrap(): Promise<McpBootstrapResult> {
  const ctx = await bootstrap({ mcpSource: true, orgRequired: false });
  if (ctx.authKind === "oauth" && ctx.orgSlug === undefined) return { ctx, tenantId: undefined };
  const tenantId = await requireTenantId(ctx);
  return { ctx, tenantId };
}

/**
 * The CLI host's tool context when an org is bound. The org is fixed for the
 * life of the process: `bootstrap()` has already applied `--org` / $REOCLO_ORG /
 * `.reoclo` (minting an in-memory tenant_switch token when it differs from the
 * login org). So no `organization` argument is exposed, and any value a client
 * passes anyway is ignored. With no binding, see {@link buildUnboundMcpContext}.
 */
export function buildCliMcpContext(client: HttpClient, tenantId: string): McpRegistrationContext {
  return {
    client,
    orgParam: {},
    resolveOrg: () => Promise.resolve({ tenantId, client }),
  };
}

/**
 * The CLI host's tool context when nothing binds an org. Every tenant-scoped
 * tool requires an `organization` slug, resolved per call the same way `--org`
 * is (`resolve`, normally a bootstrap with that org) and kept for the life of
 * the process. A failed resolution is not kept, so the next call tries again.
 */
export function buildUnboundMcpContext(client: HttpClient, resolve: (org: string) => Promise<OrgScope>): McpRegistrationContext {
  const scopes = new Map<string, Promise<OrgScope>>();
  return {
    client,
    orgParam: { organization: z.string().min(1).describe(UNBOUND_ORG_DESCRIPTION) },
    resolveOrg: (organization?: unknown) => {
      const org = typeof organization === "string" ? organization.trim() : "";
      if (!org) return Promise.reject(new Error(MISSING_ORG_MESSAGE));
      const known = scopes.get(org);
      if (known) return known;
      const scope = resolve(org);
      scopes.set(org, scope);
      scope.catch(() => scopes.delete(org));
      return scope;
    },
  };
}

async function orgScopeFor(org: string): Promise<OrgScope> {
  const ctx = await bootstrap({ org, mcpSource: true });
  return { tenantId: await requireTenantId(ctx), client: ctx.client };
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
      // make the loop redundantly refresh once more right at startup. An
      // --org token is minted in memory and never stored, so its expiry comes
      // from the token itself: the profile's expiry says nothing about it.
      let stopRefresh: (() => void) | undefined;
      if (ctx.refresh) {
        const expiresAtOf = ctx.orgSwitched
          ? (token: string): Promise<string | undefined> => Promise.resolve(jwtExpiresAt(token))
          : async (): Promise<string | undefined> =>
              (await loadConfig()).profiles[ctx.profileName]?.access_token_expires_at;
        const initialExpiresAt = await expiresAtOf(ctx.token);
        stopRefresh = startTokenRefreshLoop({
          refresh: ctx.refresh,
          // ctx.token is only the bootstrap-time snapshot used to seed the
          // loop. The loop tracks the live token itself from here on, updating
          // it from each successful refresh, so it never drifts from what
          // onToken pushes into the client.
          initialToken: ctx.token,
          onToken: (t) => ctx.client.updateToken(t),
          getExpiresAt: expiresAtOf,
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
        const mcpContext =
          tenantId === undefined ? buildUnboundMcpContext(ctx.client, orgScopeFor) : buildCliMcpContext(ctx.client, tenantId);
        const server = createMcpServer(mcpContext);
        // Loaded on demand: the tunnel tools reach the daemon on this machine, and the hosted MCP has no such daemon.
        const { registerLocalTunnelTools } = await import("../mcp/local/tunnels");
        const { connectToDaemon } = await import("../tunnels/control-client");
        registerLocalTunnelTools(server, {
          ctx: mcpContext,
          org: ctx.orgSlug,
          profile: ctx.profileName,
          connect: (identity) => connectToDaemon({ identity }),
        });
        await server.connect(new StdioServerTransport());
      } finally {
        stopRefresh?.();
        console.log = origLog;
      }
    });
}
