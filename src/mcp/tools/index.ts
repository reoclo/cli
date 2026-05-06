// src/mcp/tools/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpRegistrationContext } from "./context";
import { registerApplicationTools } from "./applications";
import { registerAuthTools } from "./auth";
import { registerDeploymentTools } from "./deployments";
import { registerDomainTools } from "./domains";
import { registerLogTools } from "./logs";
import { registerMonitorTools } from "./monitors";
import { registerOtherTools } from "./other";
import { registerRuntimeTools } from "./runtime";
import { registerScheduledOperationTools } from "./scheduled-operations";
import { registerServerTools } from "./servers";
import { registerStatusPageTools } from "./status-pages";

export type { McpRegistrationContext } from "./context";

export function registerAllTools(server: McpServer, ctx: McpRegistrationContext): void {
  registerServerTools(server, ctx);
  registerApplicationTools(server, ctx);
  registerDeploymentTools(server, ctx);
  registerLogTools(server, ctx);
  registerDomainTools(server, ctx);
  registerMonitorTools(server, ctx);
  registerStatusPageTools(server, ctx);
  registerOtherTools(server, ctx);
  registerRuntimeTools(server, ctx);
  registerAuthTools(server, ctx);
  registerScheduledOperationTools(server, ctx);
}
