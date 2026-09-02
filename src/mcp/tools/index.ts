// src/mcp/tools/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpRegistrationContext } from "./context";
import { registerApplicationTools } from "./applications";
import { registerAuthTools } from "./auth";
import { registerDeploymentTools } from "./deployments";
import { registerDomainTools } from "./domains";
import { registerGitProviderTools } from "./git-providers";
import { registerGroupTools } from "./groups";
import { registerLogTools } from "./logs";
import { registerMonitorTools } from "./monitors";
import { registerOtherTools } from "./other";
import { registerRuntimeTools } from "./runtime";
import { registerScheduledOperationTools } from "./scheduled-operations";
import { registerServerTools } from "./servers";
import { registerStatusPageTools } from "./status-pages";
import { registerTunnelTools } from "./tunnels";
import { registerVolumeTools } from "./volumes";

export type { McpRegistrationContext } from "./context";

export function registerAllTools(server: McpServer, ctx: McpRegistrationContext): void {
  registerServerTools(server, ctx);
  registerApplicationTools(server, ctx);
  registerDeploymentTools(server, ctx);
  registerGroupTools(server, ctx);
  registerLogTools(server, ctx);
  registerDomainTools(server, ctx);
  registerGitProviderTools(server, ctx);
  registerMonitorTools(server, ctx);
  registerStatusPageTools(server, ctx);
  registerTunnelTools(server, ctx);
  registerOtherTools(server, ctx);
  registerRuntimeTools(server, ctx);
  registerVolumeTools(server, ctx);
  registerAuthTools(server, ctx);
  registerScheduledOperationTools(server, ctx);
}
