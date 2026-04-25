/**
 * Log tools: search and inspect aggregated logs.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpRegistrationContext } from "./context";
import { asToolError, asToolResult } from "./common";

export function registerLogTools(
  server: McpServer,
  ctx: McpRegistrationContext,
): void {
  const tenantId = ctx.tenantId;
  if (!tenantId) return;

  server.tool(
    "search_logs",
    "Search aggregated logs with filters (paginated Loki query)",
    {
      search: z.string().optional().describe("Text search string"),
      server_id: z.string().optional().describe("Filter by server ID"),
      source_type: z
        .enum([
          "container",
          "system",
          "docker_daemon",
          "runner",
          "kernel",
          "auth",
        ])
        .optional()
        .describe("Log source type"),
      source_name: z.string().optional().describe("Log source name"),
      stream: z
        .enum(["stdout", "stderr", "journal"])
        .optional()
        .describe("Output stream filter"),
      level: z.string().optional().describe("Log level filter (info, warn, error)"),
      from_date: z.string().optional().describe("Start time (ISO 8601)"),
      to_date: z.string().optional().describe("End time (ISO 8601)"),
      page: z.number().int().positive().optional().describe("Page number"),
      page_size: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Results per page (1-500)"),
    },
    async ({
      search,
      server_id,
      source_type,
      source_name,
      stream,
      level,
      from_date,
      to_date,
      page,
      page_size,
    }: {
      search?: string;
      server_id?: string;
      source_type?: string;
      source_name?: string;
      stream?: string;
      level?: string;
      from_date?: string;
      to_date?: string;
      page?: number;
      page_size?: number;
    }) => {
      try {
        const params = new URLSearchParams();
        if (search) params.set("search", search);
        if (server_id) params.set("server_id", server_id);
        if (source_type) params.set("source_type", source_type);
        if (source_name) params.set("source_name", source_name);
        if (stream) params.set("stream", stream);
        if (level) params.set("level", level);
        if (from_date) params.set("from_date", from_date);
        if (to_date) params.set("to_date", to_date);
        if (page) params.set("page", String(page));
        if (page_size) params.set("page_size", String(page_size));
        const qs = params.toString();
        const logs = await ctx.client.get(`/tenants/${tenantId}/logs${qs ? `?${qs}` : ""}`);
        return asToolResult(logs);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "live_logs",
    "Stream recent live logs from a server for real-time log inspection",
    {
      server_id: z.string().min(1).describe("Server ID"),
      source_type: z
        .enum([
          "container",
          "system",
          "docker_daemon",
          "runner",
          "kernel",
          "auth",
        ])
        .describe("Log source type (required)"),
      source_name: z.string().min(1).describe("Source name, e.g. container name or journal unit (required)"),
      tail: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe("Number of recent lines to return (1-5000)"),
      since: z
        .string()
        .optional()
        .describe("Start time (ISO 8601), only return logs after this time"),
      search: z.string().optional().describe("Text search filter"),
      level: z.string().optional().describe("Log level filter (info, warn, error)"),
    },
    async ({
      server_id,
      source_type,
      source_name,
      tail,
      since,
      search,
      level,
    }: {
      server_id: string;
      source_type: string;
      source_name: string;
      tail?: number;
      since?: string;
      search?: string;
      level?: string;
    }) => {
      try {
        const params = new URLSearchParams();
        params.set("server_id", server_id);
        params.set("source_type", source_type);
        params.set("source_name", source_name);
        if (tail) params.set("tail", String(tail));
        if (since) params.set("since", since);
        if (search) params.set("search", search);
        if (level) params.set("level", level);
        const logs = await ctx.client.get(`/tenants/${tenantId}/logs/live?${params.toString()}`);
        return asToolResult(logs);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_system_logs",
    "Get journal/system logs for a specific systemd unit on a server",
    {
      server_id: z.string().min(1).describe("Server ID"),
      unit: z
        .enum([
          "system",
          "docker.service",
          "sshd.service",
          "kernel",
          "reoclo-runner.service",
        ])
        .describe("Systemd unit to inspect"),
      tail: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe("Number of recent lines to return"),
      since: z
        .string()
        .optional()
        .describe("Start time (ISO 8601), only return logs after this time"),
      level: z.string().optional().describe("Log level filter (info, warn, error)"),
    },
    async ({
      server_id,
      unit,
      tail,
      since,
      level,
    }: {
      server_id: string;
      unit: string;
      tail?: number;
      since?: string;
      level?: string;
    }) => {
      try {
        const unitMap: Record<string, { source_type: string; source_name: string }> =
          {
            system: { source_type: "system", source_name: "system" },
            "docker.service": {
              source_type: "docker_daemon",
              source_name: "docker.service",
            },
            "sshd.service": {
              source_type: "auth",
              source_name: "sshd.service",
            },
            kernel: { source_type: "kernel", source_name: "kernel" },
            "reoclo-runner.service": {
              source_type: "runner",
              source_name: "reoclo-runner.service",
            },
          };
        const mapped = unitMap[unit];
        const params = new URLSearchParams();
        params.set("server_id", server_id);
        if (mapped) {
          params.set("source_type", mapped.source_type);
          params.set("source_name", mapped.source_name);
        }
        if (tail) params.set("tail", String(tail));
        if (since) params.set("since", since);
        if (level) params.set("level", level);
        const logs = await ctx.client.get(`/tenants/${tenantId}/logs/live?${params.toString()}`);
        return asToolResult(logs);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_log_usage",
    "Get log storage usage statistics for the tenant",
    {},
    async () => {
      try {
        const usage = await ctx.client.get(`/tenants/${tenantId}/logs/usage`);
        return asToolResult(usage);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_server_log_sources",
    "Discover available log sources (servers, containers, systemd units)",
    {},
    async () => {
      try {
        const sources = await ctx.client.get(`/tenants/${tenantId}/logs/sources`);
        return asToolResult(sources);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_log_stats",
    "Get log volume statistics and error rates",
    {
      since: z.string().optional().describe("Start time (ISO 8601)"),
      until: z.string().optional().describe("End time (ISO 8601)"),
    },
    async ({ since, until }: { since?: string; until?: string }) => {
      try {
        const params = new URLSearchParams();
        if (since) params.set("since", since);
        if (until) params.set("until", until);
        const qs = params.toString();
        const stats = await ctx.client.get(`/tenants/${tenantId}/logs/stats${qs ? `?${qs}` : ""}`);
        return asToolResult(stats);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
