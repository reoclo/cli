// src/commands/mcp.ts
import type { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bootstrap } from "../client/bootstrap";
import { createMcpServer } from "../mcp/server";
import { startTokenRefreshLoop, PROACTIVE_SKEW_MS } from "../auth/proactive";
import { loadConfig } from "../config/store";

export function registerMcp(program: Command): void {
  program
    .command("mcp")
    // No command-local `--profile` — the global flag is honored by bootstrap()
    // (which reads the captured global override, then $REOCLO_PROFILE, then the
    // active profile).
    .description("start the stdio MCP server")
    .action(async () => {
      const ctx = await bootstrap({ mcpSource: true });

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
        const server = createMcpServer({
          client: ctx.client,
          tenantId: ctx.tenantId,
        });
        await server.connect(new StdioServerTransport());
      } finally {
        stopRefresh?.();
        console.log = origLog;
      }
    });
}
