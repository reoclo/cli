/**
 * Secret project tools — metadata only. A model can find a project and
 * rename it or change its description, but nothing here lists keys or
 * returns values: those stay behind `reoclo secrets get` / `reoclo run`,
 * where every reveal is audited against a human or machine principal.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { asToolError, asToolResult } from "./common";
import type { McpRegistrationContext } from "./context";

export function registerSecretProjectTools(server: McpServer, ctx: McpRegistrationContext): void {
  server.tool(
    "list_secret_projects",
    "List the secret projects the caller can see: id, name, description, and " +
      "how many keys each holds. Never returns keys or values. Use the id " +
      "with update_secret_project.",
    { ...ctx.orgParam },
    async (args) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const projects = await client.get(`/tenants/${tenantId}/secret-projects`);
        // Project to the documented fields. The raw document also carries
        // tenant_id, created_by, and allowed_server_ids, which the model has
        // no use for here.
        const rows = Array.isArray(projects) ? projects : [];
        const summary = rows.map((row) => {
          const r = row as Record<string, unknown>;
          return {
            id: r["id"],
            name: r["name"],
            description: r["description"] ?? null,
            secret_count: r["secret_count"],
            created_at: r["created_at"],
          };
        });
        return asToolResult(summary);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "update_secret_project",
    "Rename a secret project or change its description. Pass an empty " +
      "description to clear it. Keys, values, grants, and app bindings are " +
      "untouched. Names should stay unique: the CLI selects projects by " +
      "name, so a duplicate makes both unreachable that way. Callers that " +
      "select the project by name must use the new name after a rename.",
    {
      ...ctx.orgParam,
      project_id: z.string().uuid().describe("Secret project ID (from list_secret_projects)"),
      name: z.string().trim().min(1).max(120).optional().describe("New project name"),
      description: z
        .string()
        .max(500)
        .optional()
        .describe("New description; an empty string clears it"),
    },
    async ({ project_id, name, description, ...args }) => {
      try {
        // Same rules as `reoclo secrets projects update` (buildProjectUpdate
        // in src/commands/secrets.ts): trim both fields, a blank description
        // clears it, and an empty PATCH is refused before any request.
        const body: { name?: string; description?: string | null } = {};
        if (name !== undefined) body.name = name;
        if (description !== undefined) {
          const trimmed = description.trim();
          body.description = trimmed === "" ? null : trimmed;
        }
        if (Object.keys(body).length === 0) {
          throw new Error("nothing to update: pass name and/or description");
        }
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const updated = await client.patch(
          `/tenants/${tenantId}/secret-projects/${project_id}`,
          body,
        );
        return asToolResult(updated);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
