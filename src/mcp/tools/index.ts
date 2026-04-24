// src/mcp/tools/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HttpClient } from "../../client/http";

export interface McpRegistrationContext {
  client: HttpClient;
  tenantId: string | undefined;
}

export function registerAllTools(server: McpServer, _ctx: McpRegistrationContext): void {
  // Placeholder — actual tool migration is Task 6.1b/c/d.
  // For now, register one trivial tool so the protocol round-trip is testable.
  server.tool(
    "ping",
    "Returns 'pong' — placeholder tool used to verify the MCP server boots.",
    {},
    () => ({
      content: [{ type: "text", text: "pong" }],
    }),
  );

  // Suppress unused-var lint for the schema import. The real tools (Task 6.1b+)
  // will use `z.object({...})` schemas.
  void z;
}
