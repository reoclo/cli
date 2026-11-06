/**
 * Log watcher finding tools: what the watcher agent surfaced from an
 * organization's logs. Read-only; resolving a finding stays a CLI/app action.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpRegistrationContext } from "./context";
import { asToolError, asToolResult } from "./common";

export function registerFindingTools(
  server: McpServer,
  ctx: McpRegistrationContext,
): void {
  server.tool(
    "list_findings",
    "List log watcher findings for an organization (open ones unless a status is given). These are separate from alerts and incidents.",
    {
      ...ctx.orgParam,
      status: z
        .enum(["open", "acknowledged", "resolved", "muted", "all"])
        .optional()
        .describe("Finding status (default open); all returns every status"),
      severity: z
        .enum(["info", "low", "medium", "high", "critical"])
        .optional()
        .describe("Only findings of this severity"),
      application_id: z.string().optional().describe("Only findings for this application ID"),
      server_id: z.string().optional().describe("Only findings for this server ID"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Most findings to return (default 50, max 200)"),
    },
    async ({ status, severity, application_id, server_id, limit, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const params = new URLSearchParams();
        const wanted = status ?? "open";
        if (wanted !== "all") params.set("status", wanted);
        if (severity) params.set("severity", severity);
        if (application_id) params.set("application_id", application_id);
        if (server_id) params.set("server_id", server_id);
        if (limit !== undefined) params.set("page_size", String(limit));
        const qs = params.toString() ? `?${params.toString()}` : "";
        const page = await client.get(`/tenants/${tenantId}/log-watcher/findings${qs}`);
        return asToolResult(page);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_finding",
    "Get one log watcher finding with its evidence log lines and remediation hypothesis",
    { ...ctx.orgParam, finding_id: z.string().min(1).describe("Finding ID") },
    async ({ finding_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const finding = await client.get(
          `/tenants/${tenantId}/log-watcher/findings/${finding_id}`,
        );
        return asToolResult(finding);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
