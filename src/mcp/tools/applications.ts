/**
 * Application tools: list, inspect, config, and trigger deploys.
 * No create/delete tools (non-destructive guardrails).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpRegistrationContext } from "./context";
import { asToolError, asToolResult } from "./common";

export function registerApplicationTools(
  server: McpServer,
  ctx: McpRegistrationContext,
): void {
  const tenantId = ctx.tenantId;
  if (!tenantId) return;

  server.tool(
    "list_applications",
    "List all applications in your tenant",
    {},
    async () => {
      try {
        const apps = await ctx.client.get(`/tenants/${tenantId}/applications/`);
        return asToolResult(apps);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_application",
    "Get detailed info for an application",
    { application_id: z.string().min(1).describe("Application ID") },
    async ({ application_id }) => {
      try {
        const app = await ctx.client.get(
          `/tenants/${tenantId}/applications/${application_id}`,
        );
        return asToolResult(app);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_app_config",
    "Get the build and runtime configuration for an application",
    { application_id: z.string().min(1).describe("Application ID") },
    async ({ application_id }) => {
      try {
        const config = await ctx.client.get(
          `/tenants/${tenantId}/applications/${application_id}/config`,
        );
        return asToolResult(config);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "update_app_config",
    "Update build or runtime configuration for an application",
    {
      application_id: z.string().min(1).describe("Application ID"),
      config: z.record(z.string(), z.unknown()).describe("Configuration key-value pairs to update"),
    },
    async ({ application_id, config }) => {
      try {
        const updated = await ctx.client.patch(
          `/tenants/${tenantId}/applications/${application_id}/config`,
          config,
        );
        return asToolResult(updated);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "trigger_deploy",
    "Trigger a new deployment for an application",
    {
      application_id: z.string().min(1).describe("Application ID"),
      commit_ref: z.string().optional().describe("Git commit or branch (defaults to main)"),
    },
    async ({ application_id, commit_ref }) => {
      try {
        const deployment = await ctx.client.post(
          `/tenants/${tenantId}/applications/${application_id}/deploy`,
          { ...(commit_ref ? { commit_ref } : {}) },
        );
        return asToolResult(deployment);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
