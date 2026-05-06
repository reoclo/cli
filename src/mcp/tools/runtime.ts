/**
 * Runtime container management tools — recreate, scale, label-edit, fleet list.
 * Wraps the Plan 2A backend endpoints. All tools require the tenant flag
 * `TENANT_RUNTIME_CONTROL_ENABLED=true` server-side; without it the calls
 * return 404 and the user gets a clear error.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { asToolError, asToolResult } from "./common";
import type { McpRegistrationContext } from "./context";

export function registerRuntimeTools(
  server: McpServer,
  ctx: McpRegistrationContext,
): void {
  const tenantId = ctx.tenantId;
  if (!tenantId) return;

  // ---------------------------------------------------------------------------
  // list_tenant_containers — fleet-wide read (cache-backed)
  // ---------------------------------------------------------------------------
  server.tool(
    "list_tenant_containers",
    "List containers across the tenant fleet (cache-backed; pass refresh=true to force a live fan-out before reading).",
    {
      server_id: z.string().uuid().optional().describe("Filter to a single server"),
      application_id: z.string().uuid().optional().describe("Filter to a single application"),
      status: z
        .string()
        .optional()
        .describe("Comma-separated statuses (e.g. 'running,stopped')"),
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z.string().optional().describe("Opaque pagination cursor"),
      refresh: z
        .boolean()
        .optional()
        .describe("If true, trigger a synchronous snapshot refresh before listing."),
    },
    async ({ server_id, application_id, status, limit, cursor, refresh }) => {
      try {
        if (refresh) {
          await ctx.client.post(`/tenants/${tenantId}/runtime/refresh`, undefined);
        }
        const params = new URLSearchParams();
        if (server_id) params.set("server_id", server_id);
        if (application_id) params.set("application_id", application_id);
        if (status) params.set("status", status);
        if (limit !== undefined) params.set("limit", String(limit));
        if (cursor) params.set("cursor", cursor);
        const qs = params.toString();
        const data = await ctx.client.get(
          `/tenants/${tenantId}/runtime/containers${qs ? `?${qs}` : ""}`,
        );
        return asToolResult(data);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // recreate_container — recreate with new env/labels/ports
  // ---------------------------------------------------------------------------
  server.tool(
    "recreate_container",
    "Recreate a container with edited env, labels, or ports. persist=true syncs " +
      "changes back to the application record (requires app:env:write / " +
      "app:label:write capabilities and a non-orphan container).",
    {
      server_id: z.string().uuid().describe("Server ID where the container lives"),
      container_name: z.string().min(1).describe("Container or service name"),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe("New env map (full replacement when set)"),
      labels: z
        .record(z.string(), z.string().nullable())
        .optional()
        .describe(
          "Label patch — null value removes the key. Reserved Reoclo labels are protected.",
        ),
      ports: z
        .array(
          z.object({
            host: z.number().int(),
            container: z.number().int(),
            protocol: z.string(),
          }),
        )
        .optional(),
      persist: z
        .boolean()
        .optional()
        .describe("Sync changes to the application record (default false)"),
      replicas: z
        .number()
        .int()
        .min(0)
        .max(200)
        .optional()
        .describe("Swarm services only — replica count"),
    },
    async ({ server_id, container_name, env, labels, ports, persist, replicas }) => {
      try {
        const body: Record<string, unknown> = {};
        if (env !== undefined) body.env = env;
        if (labels !== undefined) body.labels = labels;
        if (ports !== undefined) body.ports = ports;
        if (persist !== undefined) body.persist = persist;
        if (replicas !== undefined) body.replicas = replicas;

        const data = await ctx.client.post(
          `/tenants/${tenantId}/runtime/servers/${server_id}/containers/${encodeURIComponent(
            container_name,
          )}/recreate`,
          body,
        );
        return asToolResult(data);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // scale_container — scale a Swarm service
  // ---------------------------------------------------------------------------
  server.tool(
    "scale_container",
    "Scale a Docker Swarm service to N replicas. Plain (non-Swarm) containers " +
      "return a 409 error pointing to the recreate path — convert the container " +
      "to a Swarm service first if you need scaling.",
    {
      server_id: z.string().uuid().describe("Server ID"),
      container_name: z.string().min(1).describe("Service name"),
      replicas: z.number().int().min(0).max(200).describe("Target replica count"),
    },
    async ({ server_id, container_name, replicas }) => {
      try {
        const data = await ctx.client.post(
          `/tenants/${tenantId}/runtime/servers/${server_id}/containers/${encodeURIComponent(
            container_name,
          )}/scale`,
          { replicas },
        );
        return asToolResult(data);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // update_container_labels — patch container labels
  // ---------------------------------------------------------------------------
  server.tool(
    "update_container_labels",
    "Add or remove container labels. Pass null as a value to remove a key. " +
      "Reserved Reoclo labels (reoclo.app.id, reoclo.tenant.slug, etc.) return 400. " +
      "reoclo.application_id is the canonical way to claim a manually-deployed " +
      "container into an application — requires app:label:write capability.",
    {
      server_id: z.string().uuid().describe("Server ID"),
      container_name: z.string().min(1).describe("Container or service name"),
      labels: z
        .record(z.string(), z.string().nullable())
        .describe("Label patch (null value removes the key). Must not be empty."),
    },
    async ({ server_id, container_name, labels }) => {
      try {
        const data = await ctx.client.patch(
          `/tenants/${tenantId}/runtime/servers/${server_id}/containers/${encodeURIComponent(
            container_name,
          )}/labels`,
          { labels },
        );
        return asToolResult(data);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
