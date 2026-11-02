// src/mcp/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpClient } from "../client/http";
import { registerAllTools } from "./tools/index";
import { GUIDE_INSTRUCTIONS, registerGuideTools } from "./tools/guides";
import type { McpRegistrationContext } from "./tools/context";

export function createMcpServer(ctx: McpRegistrationContext): McpServer {
  const server = new McpServer(
    {
      name: "reoclo",
      version: "1.0.0", // bound to CLI version when shipped; stub for v1 dev cycle
    },
    { instructions: GUIDE_INSTRUCTIONS },
  );

  registerAllTools(server, ctx);
  // Guides are not tenant-scoped, so they sit outside registerAllTools (whose
  // tools all take the org). The hosted server registers them the same way.
  registerGuideTools(server);

  return server;
}

export type { McpRegistrationContext };
export { type HttpClient };
