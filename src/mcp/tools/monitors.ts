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
  const tenantId = ctx.tenantId;
  if (!tenantId) return;

  server.tool(
    "list_monitors",
    "List all uptime monitors for your tenant",
    {},
    async () => {
      try {
        const monitors = await ctx.client.get(`/tenants/${tenantId}/monitors/`);
        return asToolResult(monitors);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_monitor",
    "Get details and recent checks for a monitor",
    { monitor_id: z.string().min(1).describe("Monitor ID") },
    async ({ monitor_id }) => {
      try {
        const monitor = await ctx.client.get(
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
      name: z.string().min(1).describe("Monitor display name"),
      url: z.string().url().describe("URL to monitor"),
      interval: z.number().int().positive().optional().describe("Check interval in seconds (default 60)"),
    },
    async ({ name, url, interval }) => {
      try {
        const monitor = await ctx.client.post(`/tenants/${tenantId}/monitors`, {
          name,
          url,
          ...(interval ? { interval } : {}),
        });
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
      monitor_id: z.string().min(1).describe("Monitor ID"),
      name: z.string().optional().describe("New display name"),
      url: z.string().url().optional().describe("New URL to monitor"),
      interval: z.number().int().positive().optional().describe("New check interval in seconds"),
    },
    async ({ monitor_id, name, url, interval }) => {
      try {
        const body: Record<string, unknown> = {};
        if (name) body["name"] = name;
        if (url) body["url"] = url;
        if (interval) body["interval"] = interval;
        const updated = await ctx.client.patch(
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
