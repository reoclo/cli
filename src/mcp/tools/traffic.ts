/**
 * Traffic tools: request volume, errors and latency for one application or domain.
 * Read-only proxies over the traffic read API.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpRegistrationContext } from "./context";
import { asToolError, asToolResult } from "./common";

const rangeSchema = z
  .enum(["15m", "1h", "6h", "24h", "7d", "30d", "90d"])
  .optional()
  .describe("Time range (default 1h)");

const subjectShape = {
  application_id: z.string().min(1).optional().describe("Application ID (pass this or domain_id)"),
  domain_id: z.string().min(1).optional().describe("Domain ID (pass this or application_id)"),
};

function trafficQuery(
  args: { application_id?: string; domain_id?: string },
  extra: Record<string, string | number | undefined>,
): string {
  if ((args.application_id === undefined) === (args.domain_id === undefined)) {
    throw new Error("Pass exactly one of application_id or domain_id");
  }
  const params = new URLSearchParams();
  if (args.application_id !== undefined) params.set("application_id", args.application_id);
  if (args.domain_id !== undefined) params.set("domain_id", args.domain_id);
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

export function registerTrafficTools(server: McpServer, ctx: McpRegistrationContext): void {
  server.tool(
    "get_traffic_summary",
    "Get request traffic for one application or domain: requests, errors, latency percentiles and bytes for the range, the same figures for the previous period, and a time series. Pass route and method together to read a single route.",
    {
      ...ctx.orgParam,
      ...subjectShape,
      range: rangeSchema,
      route: z.string().min(1).optional().describe("Route template, e.g. /users/:id (needs method)"),
      method: z.string().min(1).optional().describe("HTTP method of route, e.g. GET (needs route)"),
    },
    async ({ application_id, domain_id, range, route, method, ...args }) => {
      try {
        if ((route === undefined) !== (method === undefined)) {
          throw new Error("Pass route and method together");
        }
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const qs = trafficQuery(
          { application_id, domain_id },
          { range, route, method: method?.toUpperCase() },
        );
        return asToolResult(await client.get(`/tenants/${tenantId}/traffic/summary?${qs}`));
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "list_traffic_routes",
    "List the busiest routes of one application or domain with request counts, error rate and latency percentiles for the range",
    {
      ...ctx.orgParam,
      ...subjectShape,
      range: rangeSchema,
      sort: z
        .enum(["requests", "errors", "p95", "bytes"])
        .optional()
        .describe("Order by requests (default), errors, p95 latency or bytes out"),
      limit: z.number().int().min(1).max(200).optional().describe("Routes to return (1-200, default 50)"),
    },
    async ({ application_id, domain_id, range, sort, limit, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const qs = trafficQuery({ application_id, domain_id }, { range, sort, limit });
        return asToolResult(await client.get(`/tenants/${tenantId}/traffic/routes?${qs}`));
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
