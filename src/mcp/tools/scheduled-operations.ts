/**
 * Scheduled operation tools: CRUD, lifecycle, and run history.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpRegistrationContext } from "./context";
import { asToolError, asToolResult } from "./common";

export function registerScheduledOperationTools(
  server: McpServer,
  ctx: McpRegistrationContext,
): void {
  const tenantId = ctx.tenantId;
  if (!tenantId) return;

  const base = `/tenants/${tenantId}/scheduled-operations`;

  server.tool(
    "list_scheduled_operations",
    "List scheduled operations for your tenant",
    {
      status: z
        .enum(["ACTIVE", "PAUSED"])
        .optional()
        .describe("Filter by status"),
      operation_type: z
        .enum(["DEPLOY", "COMMAND", "RESTART", "REBOOT"])
        .optional()
        .describe("Filter by operation type"),
    },
    async ({ status, operation_type }) => {
      try {
        const params = new URLSearchParams();
        if (status) params.set("status", status);
        if (operation_type) params.set("operation_type", operation_type);
        const qs = params.toString();
        const ops = await ctx.client.get(`${base}/${qs ? `?${qs}` : ""}`);
        return asToolResult(ops);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_scheduled_operation",
    "Get details of a scheduled operation including its current state",
    {
      operation_id: z.string().min(1).describe("Scheduled operation ID"),
    },
    async ({ operation_id }) => {
      try {
        const op = await ctx.client.get(`${base}/${operation_id}`);
        return asToolResult(op);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "list_operation_runs",
    "List run history for a scheduled operation",
    {
      operation_id: z.string().min(1).describe("Scheduled operation ID"),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max number of runs to return"),
    },
    async ({ operation_id, limit }) => {
      try {
        const params = new URLSearchParams();
        if (limit) params.set("limit", String(limit));
        const qs = params.toString();
        const runs = await ctx.client.get(`${base}/${operation_id}/runs${qs ? `?${qs}` : ""}`);
        return asToolResult(runs);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_operation_run",
    "Get details of a single scheduled operation run",
    {
      operation_id: z.string().min(1).describe("Scheduled operation ID"),
      run_id: z.string().min(1).describe("Run ID"),
    },
    async ({ operation_id, run_id }) => {
      try {
        const run = await ctx.client.get(
          `${base}/${operation_id}/runs/${run_id}`,
        );
        return asToolResult(run);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "create_scheduled_operation",
    "Create a new scheduled operation (deploy, command, restart, or reboot)",
    {
      name: z.string().min(1).describe("Operation name"),
      description: z.string().optional().describe("Operation description"),
      operation_type: z
        .enum(["DEPLOY", "COMMAND", "RESTART", "REBOOT"])
        .describe("Type of operation"),
      schedule_kind: z
        .enum(["CRON", "ONCE"])
        .describe("CRON for recurring, ONCE for one-time"),
      cron_expression: z
        .string()
        .optional()
        .describe("5-field cron expression (required for CRON)"),
      timezone: z
        .string()
        .optional()
        .describe("IANA timezone (default: UTC)"),
      scheduled_at: z
        .string()
        .optional()
        .describe("ISO datetime for one-time execution (required for ONCE)"),
      server_id: z
        .string()
        .optional()
        .describe("Server ID (required for COMMAND, RESTART, REBOOT)"),
      application_id: z
        .string()
        .optional()
        .describe("Application ID (required for DEPLOY, RESTART)"),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Operation parameters (e.g. {"command": "apt update"} for COMMAND)',
        ),
      concurrency_policy: z
        .enum(["SKIP", "QUEUE", "REPLACE"])
        .optional()
        .describe("What to do if previous run is still active (default: SKIP)"),
      max_retries: z
        .number()
        .int()
        .min(0)
        .max(3)
        .optional()
        .describe("Max retry attempts (0-3)"),
      timeout_seconds: z
        .number()
        .int()
        .min(30)
        .max(3600)
        .optional()
        .describe("Execution timeout in seconds (30-3600)"),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = {
          name: args.name,
          operation_type: args.operation_type,
          schedule_kind: args.schedule_kind,
        };
        if (args.description) body["description"] = args.description;
        if (args.cron_expression)
          body["cron_expression"] = args.cron_expression;
        if (args.timezone) body["timezone"] = args.timezone;
        if (args.scheduled_at) body["scheduled_at"] = args.scheduled_at;
        if (args.server_id) body["server_id"] = args.server_id;
        if (args.application_id)
          body["application_id"] = args.application_id;
        if (args.params) body["params"] = args.params;
        if (args.concurrency_policy)
          body["concurrency_policy"] = args.concurrency_policy;
        if (args.max_retries !== undefined)
          body["max_retries"] = args.max_retries;
        if (args.timeout_seconds !== undefined)
          body["timeout_seconds"] = args.timeout_seconds;
        const op = await ctx.client.post(`${base}/`, body);
        return asToolResult(op);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "update_scheduled_operation",
    "Update configuration of a scheduled operation",
    {
      operation_id: z.string().min(1).describe("Scheduled operation ID"),
      name: z.string().optional().describe("New name"),
      description: z.string().optional().describe("New description"),
      cron_expression: z
        .string()
        .optional()
        .describe("New cron expression"),
      timezone: z.string().optional().describe("New timezone"),
      scheduled_at: z.string().optional().describe("New scheduled time"),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("New operation parameters"),
      concurrency_policy: z
        .enum(["SKIP", "QUEUE", "REPLACE"])
        .optional()
        .describe("New concurrency policy"),
      max_retries: z
        .number()
        .int()
        .min(0)
        .max(3)
        .optional()
        .describe("New max retries"),
      timeout_seconds: z
        .number()
        .int()
        .min(30)
        .max(3600)
        .optional()
        .describe("New timeout"),
    },
    async ({ operation_id, ...fields }) => {
      try {
        const body: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(fields)) {
          if (value !== undefined) body[key] = value;
        }
        const op = await ctx.client.patch(`${base}/${operation_id}`, body);
        return asToolResult(op);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "delete_scheduled_operation",
    "Delete a scheduled operation (soft delete)",
    {
      operation_id: z.string().min(1).describe("Scheduled operation ID"),
    },
    async ({ operation_id }) => {
      try {
        const result = await ctx.client.del(`${base}/${operation_id}`);
        return asToolResult(result ?? { deleted: true });
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "pause_scheduled_operation",
    "Pause a scheduled operation (stops future runs)",
    {
      operation_id: z.string().min(1).describe("Scheduled operation ID"),
    },
    async ({ operation_id }) => {
      try {
        const op = await ctx.client.post(
          `${base}/${operation_id}/pause`,
          {},
        );
        return asToolResult(op);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "resume_scheduled_operation",
    "Resume a paused scheduled operation",
    {
      operation_id: z.string().min(1).describe("Scheduled operation ID"),
    },
    async ({ operation_id }) => {
      try {
        const op = await ctx.client.post(
          `${base}/${operation_id}/resume`,
          {},
        );
        return asToolResult(op);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "trigger_scheduled_operation",
    "Manually trigger a scheduled operation to run now",
    {
      operation_id: z.string().min(1).describe("Scheduled operation ID"),
    },
    async ({ operation_id }) => {
      try {
        const run = await ctx.client.post(
          `${base}/${operation_id}/trigger`,
          {},
        );
        return asToolResult(run);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
