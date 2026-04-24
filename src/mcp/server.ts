// src/mcp/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpClient } from "../client/http";
import { registerAllTools, type McpRegistrationContext } from "./tools/index";

export function createMcpServer(ctx: McpRegistrationContext): McpServer {
  const server = new McpServer({
    name: "reoclo",
    version: "1.0.0", // bound to CLI version when shipped; stub for v1 dev cycle
  });

  registerAllTools(server, ctx);

  return server;
}

export type { McpRegistrationContext };
export { type HttpClient };
