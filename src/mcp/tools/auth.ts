import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpRegistrationContext } from "./context";
import { asToolResult, asToolError } from "./common";

export function registerAuthTools(
  server: McpServer,
  ctx: McpRegistrationContext,
): void {
  server.tool(
    "whoami",
    "Show current API key context: connected tenant, role, permissions, and accessible organizations",
    {},
    async (): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> => {
      try {
        const acl = await ctx.client.get("/auth/me/acl");
        return asToolResult(acl);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
