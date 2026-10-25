/**
 * Build tools: read-only build pools and build history on build servers.
 * No create/update/delete/cancel tools (non-destructive guardrails).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { LimitSchema } from "../../client/enums";
import type { McpRegistrationContext } from "./context";
import { asToolError, asToolResult } from "./common";

export function registerBuildTools(server: McpServer, ctx: McpRegistrationContext): void {
  server.tool(
    "list_build_pools",
    "List build pools (groups of build servers that build application images)",
    { ...ctx.orgParam, limit: LimitSchema.optional().describe("Max results (default 20)") },
    async ({ limit, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const qs = limit ? `?limit=${limit}` : "";
        return asToolResult(await client.get(`/tenants/${tenantId}/build-pools/${qs}`));
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_build_pool",
    "Get one build pool: its builders, concurrency limit and in-flight builds",
    { ...ctx.orgParam, pool_id: z.string().min(1).describe("Build pool ID") },
    async ({ pool_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        return asToolResult(await client.get(`/tenants/${tenantId}/build-pools/${pool_id}`));
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "list_builds",
    "List recent builds, optionally filtered by application or build pool",
    {
      ...ctx.orgParam,
      application_id: z.string().optional().describe("Filter by application ID"),
      pool_id: z.string().optional().describe("Filter by build pool ID"),
      limit: LimitSchema.optional().describe("Max results (default 20)"),
    },
    async ({ application_id, pool_id, limit, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const params = new URLSearchParams();
        if (application_id) params.set("application_id", application_id);
        if (pool_id) params.set("pool_id", pool_id);
        if (limit) params.set("limit", String(limit));
        const qs = params.toString();
        return asToolResult(await client.get(`/tenants/${tenantId}/builds/${qs ? `?${qs}` : ""}`));
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_build",
    "Get one build: status, builder, image reference and digest, queue position",
    { ...ctx.orgParam, build_id: z.string().min(1).describe("Build ID") },
    async ({ build_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        return asToolResult(await client.get(`/tenants/${tenantId}/builds/${build_id}`));
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_build_logs",
    "Get the log tail of a build",
    { ...ctx.orgParam, build_id: z.string().min(1).describe("Build ID") },
    async ({ build_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        return asToolResult(await client.get(`/tenants/${tenantId}/builds/${build_id}/logs`));
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
