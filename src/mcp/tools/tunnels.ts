/**
 * Tunnel MCP tools — list and inspect tunnel sessions. The long-running
 * forward command stays CLI-only (LLMs can't hold a streaming WebSocket).
 * Close is intentionally absent per the non-destructive guardrail (see
 * domains.ts:1-2).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpRegistrationContext } from "./context";
import { asToolError, asToolResult } from "./common";

export function registerTunnelTools(
  server: McpServer,
  ctx: McpRegistrationContext,
): void {
  server.tool(
    "list_tunnel_sessions",
    "List tunnel sessions for the active organization. Filter by server or active-only.",
    {
      ...ctx.orgParam,
      server_id: z.string().optional().describe("Filter by server id"),
      active: z.boolean().optional().describe("Only return sessions that are still open"),
    },
    async ({ server_id, active, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const q = new URLSearchParams();
        if (server_id) q.set("server_id", server_id);
        if (active === true) q.set("active", "true");
        const qs = q.toString();
        const sessions = await client.get(
          `/tenants/${tenantId}/tunnels/${qs ? `?${qs}` : ""}`,
        );
        return asToolResult(sessions);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_tunnel_session",
    "Get a single tunnel session by id.",
    { ...ctx.orgParam, tunnel_id: z.string().min(1).describe("Tunnel session id") },
    async ({ tunnel_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const session = await client.get(
          `/tenants/${tenantId}/tunnels/${tunnel_id}`,
        );
        return asToolResult(session);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
