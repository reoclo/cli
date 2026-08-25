import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpRegistrationContext } from "./context";
import { asToolResult, asToolError, optionalOrgParam } from "./common";

export function registerAuthTools(
  server: McpServer,
  ctx: McpRegistrationContext,
): void {
  server.tool(
    "whoami",
    "Show the caller's context: role, permissions, and the organizations this connection can act on. Pass organization to see the context for that organization.",
    { ...optionalOrgParam(ctx) },
    async (args): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> => {
      try {
        const organization = typeof args.organization === "string" && args.organization.trim() ? args.organization : undefined;
        const client = organization ? (await ctx.resolveOrg(organization)).client : ctx.client;
        const acl = await client.get("/auth/me/acl");
        return asToolResult(acl);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
