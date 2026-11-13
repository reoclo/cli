/**
 * Dashboard tools: read the dashboard library, discover what a dashboard can
 * hold (panel catalog, templates), dry-run a layout, and create, replace,
 * delete, assign and default dashboards.
 *
 * Every call goes to /tenants/{tenant}/dashboards with the caller's own token,
 * so the API's permissions and visibility apply unchanged. When the API refuses
 * a write with 422, the problems come back as a structured list so an agent can
 * fix the layout and retry.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ApiError } from "../../client/errors";
import type { McpRegistrationContext } from "./context";
import { asToolError, asToolResult } from "./common";

interface DashboardProblem {
  path: string;
  code: string;
  message: string;
}

interface Refusal {
  message: string;
  problems: DashboardProblem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProblem(value: unknown): value is DashboardProblem {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  );
}

/**
 * The API's 422 detail is `{message, problems: [{path, code, message}]}`. The CLI client
 * keeps the raw response body as the error message (`{"detail": {...}}`) and the hosted
 * client keeps only the detail, so accept both shapes. Anything else is not a refusal
 * this tool can structure.
 */
function refusalOf(error: unknown): Refusal | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(error.message);
  } catch {
    // Not JSON: the generic error formatter reports the message as it is.
    return null;
  }
  const detail = isRecord(parsed) && "detail" in parsed ? parsed.detail : parsed;
  if (!isRecord(detail) || !Array.isArray(detail.problems)) return null;
  return {
    message: typeof detail.message === "string" ? detail.message : "The dashboard has problems.",
    problems: detail.problems.filter(isProblem),
  };
}

function asDashboardError(error: unknown): ReturnType<typeof asToolError> {
  const refusal = refusalOf(error);
  if (!refusal) return asToolError(error);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: "The API refused this dashboard. Fix every problem and call again.",
            status: 422,
            message: refusal.message,
            problems: refusal.problems,
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

const roleVisibilitySchema = z.object({
  roles: z
    .array(z.guid())
    .min(1)
    .describe("IDs of the custom roles that may see the dashboard. At least one."),
});

const visibilitySchema = z
  .union([z.literal("everyone"), roleVisibilitySchema])
  .describe(
    'Who may see the dashboard: the string "everyone" (every member) or {"roles": [role ids]} (only members holding one of those roles).',
  );

const layoutSchema = z
  .object({
    x: z.number().int().min(0).max(11).describe("Column, 0 to 11"),
    y: z.number().int().min(0).describe("Row, 0 or more"),
    w: z.number().int().min(1).max(12).describe("Width in columns, 1 to 12"),
    h: z.number().int().min(1).describe("Height in rows, 1 or more"),
  })
  .describe(
    "Desktop placement on a 12-column grid. x + w must not exceed 12, and panels must not overlap.",
  );

const panelSchema = z.object({
  instance_id: z
    .guid()
    .optional()
    .describe(
      "Existing panel instance ID. Keep it when updating a panel you got from dashboard_get; omit it for a new panel and the server mints one.",
    ),
  type: z
    .string()
    .min(1)
    .describe("Panel type, the `id` of an entry in dashboard_catalog `panels`."),
  size: z
    .enum(["small", "medium", "large", "full"])
    .optional()
    .describe("Footprint used when layout is omitted. Defaults to the panel type's default_size."),
  config: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Panel settings. Must satisfy the `settings_schema` (a JSON Schema) of this panel type in dashboard_catalog. Omit for the defaults.",
    ),
  layout: layoutSchema.optional().describe(
    "Omit it and the server places the panel in the first free spot using its size.",
  ),
  mobile_order: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Position of the panel in the single-column mobile layout. Omit to follow desktop order."),
});

const PANELS_NOTE =
  "Each panel is {type, size?, config?, layout?, instance_id?, mobile_order?}. Panels without layout are placed by the server.";

const LIMIT_NOTE = "An organization holds at most 20 dashboards.";

const VALIDATE_FIRST =
  "Call dashboard_validate first with the same body to get every problem in one pass.";

export function registerDashboardTools(
  server: McpServer,
  ctx: McpRegistrationContext,
): void {
  server.tool(
    "dashboards_list",
    "List the dashboards the caller can see in an organization, without panel data. Each entry has id, name, visibility, panel_count, is_home, is_default, assigned_roles, can_edit and can_delete. The response also carries total, limit (20), home_id, default_id, locked_home and `can` (the actions the caller holds: view, create, edit, delete, assign).",
    { ...ctx.orgParam },
    async (args) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        return asToolResult(await client.get(`/tenants/${tenantId}/dashboards/`));
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "dashboard_get",
    "Get one dashboard with its panels resolved and populated with data for the caller. Panels the caller may not see are absent. To edit a dashboard, take name, description, visibility and each panel's instance_id, type, size, config, layout and mobile_order from this result and send them to dashboard_update.",
    { ...ctx.orgParam, dashboard_id: z.guid().describe("Dashboard ID") },
    async ({ dashboard_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        return asToolResult(await client.get(`/tenants/${tenantId}/dashboards/${dashboard_id}`));
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "dashboard_catalog",
    "List what a dashboard can contain. `panels` are the panel types the caller may add: id (use it as a panel's `type`), title, description, area (the group it sits under in the editor), default_size, default_w and default_h, min_w and min_h (smallest grid span), resources (what the organization must have for the panel to show data) and settings_schema. settings_schema is a JSON Schema: a panel's `config` must validate against it, so read its properties, types, enums and required keys before writing config. `series` lists the metric series available to the metric chart panel. Call this before building panels.",
    { ...ctx.orgParam },
    async (args) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        return asToolResult(await client.get(`/tenants/${tenantId}/dashboards/catalog`));
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "dashboard_templates",
    "List the dashboard templates that fit this organization, each with the panels (type, size, layout) it would start with, plus `resources`, the resources the organization has, which decided the fit. Pass a template's id as template_id to dashboard_create.",
    { ...ctx.orgParam },
    async (args) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        return asToolResult(await client.get(`/tenants/${tenantId}/dashboards/templates`));
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "dashboard_validate",
    `Dry run of dashboard_create or dashboard_update. Saves nothing and returns {valid, problems: [{path, code, message}]} where path points into the body, for example panels[2].layout. Without dashboard_id it checks a create body (same fields as dashboard_create). With dashboard_id it checks a full replacement of that dashboard (same fields as dashboard_update: send name, description, visibility and every panel). ${VALIDATE_FIRST}`,
    {
      ...ctx.orgParam,
      dashboard_id: z
        .guid()
        .optional()
        .describe("Check an update of this dashboard instead of a create."),
      name: z.string().optional().describe("Dashboard name"),
      description: z.string().optional().describe("Dashboard description"),
      visibility: visibilitySchema.optional(),
      template_id: z.string().optional().describe("Create from this template. Create checks only."),
      duplicate_of: z.guid().optional().describe("Create as a copy of this dashboard. Create checks only."),
      panels: z.array(panelSchema).optional().describe(PANELS_NOTE),
    },
    async ({ dashboard_id, name, description, visibility, template_id, duplicate_of, panels, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const body: Record<string, unknown> = {};
        if (dashboard_id !== undefined) body.dashboard_id = dashboard_id;
        if (name !== undefined) body.name = name;
        if (description !== undefined) body.description = description;
        if (visibility !== undefined) body.visibility = visibility;
        if (template_id !== undefined) body.template_id = template_id;
        if (duplicate_of !== undefined) body.duplicate_of = duplicate_of;
        if (panels !== undefined) body.panels = panels;
        return asToolResult(await client.post(`/tenants/${tenantId}/dashboards/validate`, body));
      } catch (error: unknown) {
        return asDashboardError(error);
      }
    },
  );

  server.tool(
    "dashboard_create",
    `Create a dashboard. Start it one of four ways, sending at most one of template_id, duplicate_of and panels: blank (send none), from a template (template_id from dashboard_templates), as a copy of another dashboard (duplicate_of), or from a full panel list (panels). name is required unless a template or the copied dashboard supplies it. ${PANELS_NOTE} The grid has 12 columns (x, w) and unlimited rows (y, h). ${LIMIT_NOTE} ${VALIDATE_FIRST} If the API refuses the write, the result is an error whose \`problems\` list says what to fix.`,
    {
      ...ctx.orgParam,
      name: z.string().optional().describe("Dashboard name"),
      description: z.string().optional().describe("Dashboard description"),
      visibility: visibilitySchema.optional().describe(
        'Defaults to "everyone". Use {"roles": [role ids]} to share with some roles only.',
      ),
      template_id: z.string().optional().describe("Start from this template (see dashboard_templates)"),
      duplicate_of: z.guid().optional().describe("Start as a copy of this dashboard ID"),
      panels: z.array(panelSchema).optional().describe(PANELS_NOTE),
    },
    async ({ name, description, visibility, template_id, duplicate_of, panels, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const body: Record<string, unknown> = {};
        if (name !== undefined) body.name = name;
        if (description !== undefined) body.description = description;
        if (visibility !== undefined) body.visibility = visibility;
        if (template_id !== undefined) body.template_id = template_id;
        if (duplicate_of !== undefined) body.duplicate_of = duplicate_of;
        if (panels !== undefined) body.panels = panels;
        return asToolResult(await client.post(`/tenants/${tenantId}/dashboards/`, body));
      } catch (error: unknown) {
        return asDashboardError(error);
      }
    },
  );

  server.tool(
    "dashboard_update",
    `Replace a dashboard: the name, description, visibility and panels you send become the whole dashboard. Anything you leave out is reset (an omitted visibility becomes "everyone", an omitted description is cleared, panels not listed are removed), so start from dashboard_get and send the full result back with your changes. ${PANELS_NOTE} Keep instance_id on panels you are keeping. ${VALIDATE_FIRST} (pass dashboard_id there). If the API refuses the write, the result is an error whose \`problems\` list says what to fix.`,
    {
      ...ctx.orgParam,
      dashboard_id: z.guid().describe("Dashboard ID"),
      name: z.string().min(1).describe("Dashboard name"),
      description: z.string().optional().describe("Dashboard description. Omit to clear it."),
      visibility: visibilitySchema.optional().describe(
        'Omit and the dashboard becomes visible to "everyone". Send the current value to keep it.',
      ),
      panels: z.array(panelSchema).describe(PANELS_NOTE),
    },
    async ({ dashboard_id, name, description, visibility, panels, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const body: Record<string, unknown> = { name, panels };
        if (description !== undefined) body.description = description;
        if (visibility !== undefined) body.visibility = visibility;
        return asToolResult(
          await client.put(`/tenants/${tenantId}/dashboards/${dashboard_id}`, body),
        );
      } catch (error: unknown) {
        return asDashboardError(error);
      }
    },
  );

  server.tool(
    "dashboard_delete",
    "Delete a dashboard. Refused for the organization default dashboard and for a dashboard locked to a role; clear the default with dashboard_set_default or the assignment with dashboard_unassign first.",
    { ...ctx.orgParam, dashboard_id: z.guid().describe("Dashboard ID") },
    async ({ dashboard_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const result = await client.del(`/tenants/${tenantId}/dashboards/${dashboard_id}`);
        return asToolResult(result ?? { deleted: true });
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "dashboard_assign",
    "Assign a dashboard to a role, so members of that role land on it. A role has one assignment; assigning again replaces it. With locked true, members of the role cannot choose another home dashboard. Returns the assignment.",
    {
      ...ctx.orgParam,
      role_id: z.guid().describe("Custom role ID"),
      dashboard_id: z.guid().describe("Dashboard ID to assign"),
      locked: z
        .boolean()
        .default(false)
        .describe("Whether members of the role are locked to this dashboard. Defaults to false."),
    },
    async ({ role_id, dashboard_id, locked, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        return asToolResult(
          await client.put(`/tenants/${tenantId}/dashboards/assignments/${role_id}`, {
            dashboard_id,
            locked,
          }),
        );
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "dashboard_unassign",
    "Remove a role's dashboard assignment. Removing an assignment that does not exist is not an error.",
    { ...ctx.orgParam, role_id: z.guid().describe("Custom role ID") },
    async ({ role_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const result = await client.del(
          `/tenants/${tenantId}/dashboards/assignments/${role_id}`,
        );
        return asToolResult(result ?? { unassigned: true });
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "dashboard_set_default",
    "Set the organization's default dashboard, shown to members whose role has no assignment and who have not chosen a home. Pass null to clear it. Returns {dashboard_id}.",
    {
      ...ctx.orgParam,
      dashboard_id: z
        .guid()
        .nullable()
        .describe("Dashboard ID to make the default, or null to clear the default"),
    },
    async ({ dashboard_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        return asToolResult(
          await client.put(`/tenants/${tenantId}/dashboards/default`, { dashboard_id }),
        );
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
