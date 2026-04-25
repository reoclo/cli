/**
 * Miscellaneous tools: repos, env vars, registry creds, audit, dashboard.
 * Credentials are always masked in responses.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpRegistrationContext } from "./context";
import { asToolError, asToolResult } from "./common";

export function registerOtherTools(
  server: McpServer,
  ctx: McpRegistrationContext,
): void {
  const tenantId = ctx.tenantId;
  if (!tenantId) return;

  // Repositories
  server.tool(
    "list_repositories",
    "List connected Git repositories",
    {},
    async () => {
      try {
        const repos = await ctx.client.get(`/tenants/${tenantId}/repositories/`);
        return asToolResult(repos);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  // Environment variables (values masked)
  server.tool(
    "list_env_vars",
    "List environment variable keys for an application (values are masked)",
    { application_id: z.string().min(1).describe("Application ID") },
    async ({ application_id }) => {
      try {
        const envVars = await ctx.client.get(
          `/tenants/${tenantId}/applications/${application_id}/env`,
        );
        return asToolResult(envVars);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "set_env_var",
    "Set or update an environment variable for an application",
    {
      application_id: z.string().min(1).describe("Application ID"),
      key: z.string().min(1).describe("Variable name"),
      value: z.string().describe("Variable value"),
    },
    async ({ application_id, key, value }) => {
      try {
        const result = await ctx.client.post(
          `/tenants/${tenantId}/applications/${application_id}/env`,
          { key, value },
        );
        return asToolResult(result);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  // Registry credentials (masked)
  server.tool(
    "list_registry_creds",
    "List container registry credentials (passwords are masked)",
    {},
    async () => {
      try {
        const creds = await ctx.client.get(`/tenants/${tenantId}/registry-credentials/`);
        return asToolResult(creds);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  // Audit logs
  server.tool(
    "get_audit_log",
    "Get recent audit log entries for your tenant",
    {
      limit: z.number().int().positive().optional().describe("Max entries (default 50)"),
      action: z.string().optional().describe("Filter by action type"),
      resource_type: z.string().optional().describe("Filter by resource type"),
    },
    async ({ limit, action, resource_type }) => {
      try {
        const params = new URLSearchParams();
        if (limit) params.set("limit", String(limit));
        if (action) params.set("action", action);
        if (resource_type) params.set("resource_type", resource_type);
        const qs = params.toString();
        const logs = await ctx.client.get(`/tenants/${tenantId}/audit-logs${qs ? `?${qs}` : ""}`);
        return asToolResult(logs);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  // Dashboard
  server.tool(
    "get_dashboard",
    "Get a summary dashboard with counts and health overview",
    {},
    async () => {
      try {
        const dashboard = await ctx.client.get(`/tenants/${tenantId}/dashboard/stats`);
        return asToolResult(dashboard);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
