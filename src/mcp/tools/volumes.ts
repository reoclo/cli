/**
 * Runtime volume management tools — list, create, delete, prune Docker
 * volumes on a server. Wraps the container-volume-delete-ops backend
 * endpoints (api 1.219.0+). Volumes are live-query only: there is no local
 * persistence, so every tool hits the runtime volumes API directly. Subject
 * to the same `tenant_runtime_control` platform flag as the container tools
 * in runtime.ts.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { asToolError, asToolResult } from "./common";
import type { McpRegistrationContext } from "./context";

export function registerVolumeTools(server: McpServer, ctx: McpRegistrationContext): void {
  // ---------------------------------------------------------------------------
  // list_volumes — all volumes on a server
  // ---------------------------------------------------------------------------
  server.tool(
    "list_volumes",
    "List Docker volumes on a server. Each entry reports in_use/used_by " +
      "(which containers hold it) and protected (platform volumes that " +
      "cannot be deleted or pruned). A non-null partial_error means the " +
      "listing itself failed on the server — treat it as an error, not an " +
      "empty/healthy list.",
    {
      ...ctx.orgParam,
      server_id: z.string().uuid().describe("Server ID"),
    },
    async ({ server_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const data = await client.get(`/tenants/${tenantId}/runtime/servers/${server_id}/volumes`);
        return asToolResult(data);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // create_volume — create a named volume
  // ---------------------------------------------------------------------------
  server.tool(
    "create_volume",
    "Create a Docker volume on a server. 409 if a volume with that name " +
      "already exists; 403 for a protected platform name.",
    {
      ...ctx.orgParam,
      server_id: z.string().uuid().describe("Server ID"),
      name: z.string().min(1).describe("Volume name"),
      driver: z.string().optional().describe("Volume driver (default: docker's default, 'local')"),
      labels: z.record(z.string(), z.string()).optional().describe("Labels to set on the volume"),
    },
    async ({ server_id, name, driver, labels, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const body: Record<string, unknown> = { name };
        if (driver !== undefined) body.driver = driver;
        if (labels !== undefined) body.labels = labels;
        const data = await client.post(
          `/tenants/${tenantId}/runtime/servers/${server_id}/volumes`,
          body,
        );
        return asToolResult(data);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // delete_volume — delete a single volume
  // ---------------------------------------------------------------------------
  server.tool(
    "delete_volume",
    "Delete a Docker volume. Never forced: 409 when the volume is in use, " +
      "naming the containers holding it. Protected platform volumes " +
      "(caddy_data, caddy_config) return 403.",
    {
      ...ctx.orgParam,
      server_id: z.string().uuid().describe("Server ID"),
      name: z.string().min(1).describe("Volume name"),
    },
    async ({ server_id, name, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const data = await client.del(
          `/tenants/${tenantId}/runtime/servers/${server_id}/volumes/${encodeURIComponent(name)}`,
        );
        return asToolResult(data);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // prune_volumes — delete every unused, unprotected volume
  // ---------------------------------------------------------------------------
  server.tool(
    "prune_volumes",
    "Delete all unused volumes on a server, except protected platform " +
      "volumes (which are skipped, not deleted). Returns the removed volume " +
      "names, the skipped protected names, and reclaimed_bytes.",
    {
      ...ctx.orgParam,
      server_id: z.string().uuid().describe("Server ID"),
    },
    async ({ server_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const data = await client.post(
          `/tenants/${tenantId}/runtime/servers/${server_id}/volumes/prune`,
        );
        return asToolResult(data);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
