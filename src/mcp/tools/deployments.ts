/**
 * Deployment tools: read-only deployment history and log inspection.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpRegistrationContext } from "./context";
import { asToolError, asToolResult } from "./common";

export function registerDeploymentTools(
  server: McpServer,
  ctx: McpRegistrationContext,
): void {
  server.tool(
    "list_deployments",
    "List recent deployments, optionally filtered by application",
    {
      ...ctx.orgParam,
      application_id: z.string().optional().describe("Filter by application ID"),
      limit: z.number().int().positive().optional().describe("Max results (default 20)"),
    },
    async ({ application_id, limit, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const params = new URLSearchParams();
        if (application_id) params.set("application_id", application_id);
        if (limit) params.set("limit", String(limit));
        const qs = params.toString();
        const deployments = await client.get(`/tenants/${tenantId}/deployments/${qs ? `?${qs}` : ""}`);
        return asToolResult(deployments);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_deployment",
    "Get full details for a specific deployment",
    { ...ctx.orgParam, deployment_id: z.string().min(1).describe("Deployment ID") },
    async ({ deployment_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const deployment = await client.get(
          `/tenants/${tenantId}/deployments/${deployment_id}`,
        );
        return asToolResult(deployment);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_deployment_logs",
    "Get build/deploy logs for a deployment",
    {
      ...ctx.orgParam,
      deployment_id: z.string().min(1).describe("Deployment ID"),
      stage: z.string().optional().describe("Filter by stage (build, deploy, etc.)"),
    },
    async ({ deployment_id, stage, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const params = new URLSearchParams();
        if (stage) params.set("stage", stage);
        const qs = params.toString();
        const logs = await client.get(
          `/tenants/${tenantId}/deployments/${deployment_id}/logs${qs ? `?${qs}` : ""}`,
        );
        return asToolResult(logs);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_deployment_stages",
    "Get the pipeline stages and their status for a deployment",
    { ...ctx.orgParam, deployment_id: z.string().min(1).describe("Deployment ID") },
    async ({ deployment_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const stages = await client.get(
          `/tenants/${tenantId}/deployments/${deployment_id}/stages`,
        );
        return asToolResult(stages);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_deployment_build_log",
    "Get full deployment details including per-stage build logs",
    { ...ctx.orgParam, deployment_id: z.string().min(1).describe("Deployment ID") },
    async ({ deployment_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const deployment = await client.get(
          `/tenants/${tenantId}/deployments/${deployment_id}`,
        );
        return asToolResult(deployment);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
