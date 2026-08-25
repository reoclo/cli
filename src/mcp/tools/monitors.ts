/**
 * Monitor tools: uptime monitor management.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpRegistrationContext } from "./context";
import { asToolError, asToolResult } from "./common";

export function registerMonitorTools(
  server: McpServer,
  ctx: McpRegistrationContext,
): void {
  server.tool(
    "list_monitors",
    "List all uptime monitors for an organization",
    { ...ctx.orgParam },
    async (args) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const monitors = await client.get(`/tenants/${tenantId}/monitors/`);
        return asToolResult(monitors);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_monitor",
    "Get details and recent checks for a monitor",
    { ...ctx.orgParam, monitor_id: z.string().min(1).describe("Monitor ID") },
    async ({ monitor_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const monitor = await client.get(
          `/tenants/${tenantId}/monitors/${monitor_id}`,
        );
        return asToolResult(monitor);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "create_monitor",
    "Create a new uptime monitor",
    {
      ...ctx.orgParam,
      name: z.string().min(1).describe("Monitor display name"),
      url: z.url().describe("URL to monitor"),
      interval: z.number().int().positive().optional().describe("Check interval in seconds (default 60)"),
      check_path: z.string().optional().describe("Request path appended to the URL, e.g. /health (default /)"),
      method: z
        .enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
        .optional()
        .describe("HTTP method (default GET)"),
      timeout_seconds: z.number().int().positive().optional().describe("Request timeout in seconds, 1-120 (default 30)"),
      expected_status_min: z.number().int().optional().describe("Lowest acceptable HTTP status (default 200)"),
      expected_status_max: z.number().int().optional().describe("Highest acceptable HTTP status (default 399)"),
      response_must_contain: z.string().optional().describe("Require this substring in the response body"),
    },
    async ({
      name,
      url,
      interval,
      check_path,
      method,
      timeout_seconds,
      expected_status_min,
      expected_status_max,
      response_must_contain,
      ...args
    }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const body: Record<string, unknown> = { name, url };
        // API field is check_interval_seconds; sending `interval` was a no-op.
        if (interval !== undefined) body.check_interval_seconds = interval;
        if (check_path !== undefined) body.check_path = check_path;
        if (method !== undefined) body.method = method;
        if (timeout_seconds !== undefined) body.timeout_seconds = timeout_seconds;
        if (expected_status_min !== undefined) body.expected_status_min = expected_status_min;
        if (expected_status_max !== undefined) body.expected_status_max = expected_status_max;
        if (response_must_contain !== undefined) body.response_must_contain = response_must_contain;
        const monitor = await client.post(`/tenants/${tenantId}/monitors`, body);
        return asToolResult(monitor);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "update_monitor",
    "Update an existing monitor's configuration",
    {
      ...ctx.orgParam,
      monitor_id: z.string().min(1).describe("Monitor ID"),
      name: z.string().optional().describe("New display name"),
      url: z.url().optional().describe("New URL to monitor"),
      interval: z.number().int().positive().optional().describe("New check interval in seconds"),
      check_path: z.string().optional().describe("Request path appended to the URL, e.g. /health"),
      method: z
        .enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
        .optional()
        .describe("HTTP method"),
      timeout_seconds: z.number().int().positive().optional().describe("Request timeout in seconds (1-120)"),
      expected_status_min: z.number().int().optional().describe("Lowest acceptable HTTP status"),
      expected_status_max: z.number().int().optional().describe("Highest acceptable HTTP status"),
      response_must_contain: z.string().optional().describe("Require this substring in the response body"),
    },
    async ({
      monitor_id,
      name,
      url,
      interval,
      check_path,
      method,
      timeout_seconds,
      expected_status_min,
      expected_status_max,
      response_must_contain,
      ...args
    }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const body: Record<string, unknown> = {};
        if (name !== undefined) body.name = name;
        if (url !== undefined) body.url = url;
        // API field is check_interval_seconds; sending `interval` was a no-op.
        if (interval !== undefined) body.check_interval_seconds = interval;
        if (check_path !== undefined) body.check_path = check_path;
        if (method !== undefined) body.method = method;
        if (timeout_seconds !== undefined) body.timeout_seconds = timeout_seconds;
        if (expected_status_min !== undefined) body.expected_status_min = expected_status_min;
        if (expected_status_max !== undefined) body.expected_status_max = expected_status_max;
        if (response_must_contain !== undefined) body.response_must_contain = response_must_contain;
        const updated = await client.patch(
          `/tenants/${tenantId}/monitors/${monitor_id}`,
          body,
        );
        return asToolResult(updated);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
