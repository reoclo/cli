/**
 * Server tools: read-only server inspection and health checks.
 * No create/delete/decommission/reboot tools (non-destructive guardrails).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpRegistrationContext } from "./context";
import { asToolError, asToolResult } from "./common";

export function registerServerTools(
  server: McpServer,
  ctx: McpRegistrationContext,
): void {
  const tenantId = ctx.tenantId;
  if (!tenantId) return;

  server.tool(
    "list_servers",
    "List all servers in your tenant",
    {},
    async () => {
      try {
        const servers = await ctx.client.get(`/tenants/${tenantId}/servers/`);
        return asToolResult(servers);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_server",
    "Get detailed info for a specific server",
    { server_id: z.string().min(1).describe("Server ID") },
    async ({ server_id }) => {
      try {
        const detail = await ctx.client.get(`/tenants/${tenantId}/servers/${server_id}`);
        return asToolResult(detail);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_server_metrics",
    "Get current resource metrics (CPU, memory, disk) for a server",
    { server_id: z.string().min(1).describe("Server ID") },
    async ({ server_id }) => {
      try {
        const metrics = await ctx.client.get(`/tenants/${tenantId}/servers/${server_id}/metrics`);
        return asToolResult(metrics);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_server_health",
    "Get the latest health status for a server",
    { server_id: z.string().min(1).describe("Server ID") },
    async ({ server_id }) => {
      try {
        const health = await ctx.client.get(`/tenants/${tenantId}/servers/${server_id}/health`);
        return asToolResult(health);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "list_containers",
    "List Docker containers running on a server",
    { server_id: z.string().min(1).describe("Server ID") },
    async ({ server_id }) => {
      try {
        const containers = await ctx.client.get(
          `/tenants/${tenantId}/servers/${server_id}/containers`,
        );
        return asToolResult(containers);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "inspect_container",
    "Get detailed info about a specific container",
    {
      server_id: z.string().min(1).describe("Server ID"),
      container_id: z.string().min(1).describe("Container ID"),
    },
    async ({ server_id, container_id }) => {
      try {
        const container = await ctx.client.get(
          `/tenants/${tenantId}/servers/${server_id}/containers/${container_id}`,
        );
        return asToolResult(container);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_container_logs",
    "Get recent logs from a container",
    {
      server_id: z.string().min(1).describe("Server ID"),
      container_id: z.string().min(1).describe("Container ID"),
      tail: z.number().int().positive().optional().describe("Number of lines (default 100)"),
      since: z.string().optional().describe("Start time (ISO 8601), only return logs after this time"),
    },
    async ({ server_id, container_id, tail, since }: { server_id: string; container_id: string; tail?: number; since?: string }) => {
      try {
        const params = new URLSearchParams();
        if (tail) params.set("tail", String(tail));
        if (since) params.set("since", since);
        const qs = params.toString();
        const logs = await ctx.client.get(
          `/tenants/${tenantId}/servers/${server_id}/containers/${container_id}/logs${qs ? `?${qs}` : ""}`,
        );
        return asToolResult(logs);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_server_uptime",
    "Get server connectivity graph (uptime history as time-slot buckets). Returns status per slot: healthy, unhealthy, grace, or no_data.",
    {
      server_id: z.string().min(1).describe("Server ID"),
      hours: z.number().int().min(1).max(168).default(6).describe("Hours of history (default 6)"),
      slot_minutes: z.number().int().min(1).max(60).default(2).describe("Slot width in minutes (default 2)"),
    },
    async ({ server_id, hours, slot_minutes }: { server_id: string; hours: number; slot_minutes: number }) => {
      try {
        const params = new URLSearchParams({ hours: String(hours), slot_minutes: String(slot_minutes) });
        const result = await ctx.client.get(
          `/tenants/${tenantId}/servers/${server_id}/uptime?${params.toString()}`,
        );
        return asToolResult(result);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "port_scan",
    "Scan open ports on a server",
    { server_id: z.string().min(1).describe("Server ID") },
    async ({ server_id }) => {
      try {
        const ports = await ctx.client.get(`/tenants/${tenantId}/servers/${server_id}/ports`);
        return asToolResult(ports);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "check_server_health",
    "Trigger an on-demand health check for a server",
    { server_id: z.string().min(1).describe("Server ID") },
    async ({ server_id }) => {
      try {
        const result = await ctx.client.post(
          `/tenants/${tenantId}/servers/${server_id}/health-check`,
          {},
        );
        return asToolResult(result);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "restart_container",
    "Restart a specific Docker container on a server",
    {
      server_id: z.string().min(1).describe("Server ID"),
      container_id: z.string().min(1).describe("Container ID"),
    },
    async ({ server_id, container_id }) => {
      try {
        const result = await ctx.client.post(
          `/tenants/${tenantId}/servers/${server_id}/containers/${container_id}/restart`,
          {},
        );
        return asToolResult(result);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "exec_command",
    "Run a shell command on a server for diagnostics. Commands run as the runner service account. Elevated commands limited to the runner's sudoers whitelist. Max timeout is 300s.",
    {
      server_id: z.string().min(1).describe("Server ID"),
      command: z.string().min(1).describe("Shell command to execute"),
      timeout: z.number().int().min(5).max(300).optional().describe("Timeout in seconds (default 60)"),
    },
    async ({ server_id, command, timeout }: { server_id: string; command: string; timeout?: number }) => {
      try {
        const result = await ctx.client.post(
          `/tenants/${tenantId}/servers/${server_id}/exec`,
          { command, timeout: timeout ?? 60 },
        );
        return asToolResult(result);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
