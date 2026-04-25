// src/mcp/tools/context.ts
import type { HttpClient } from "../../client/http";

export interface McpRegistrationContext {
  client: HttpClient;
  tenantId: string | undefined;
}
