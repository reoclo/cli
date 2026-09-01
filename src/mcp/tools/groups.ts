/**
 * Group (stack) tools: coordinated compose deployments (REO-235).
 *
 * The API addresses groups, group deployments, and members by UUID only.
 * Model callers hold slugs, deployment numbers, and compose service names,
 * so each handler resolves those references first, the same way
 * `reoclo groups` does. Resolution failures throw model-readable errors
 * that name the available references.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpRegistrationContext } from "./context";
import { asToolError, asToolResult } from "./common";
import type { HttpClient } from "../../client/http";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface GroupSummary {
  id: string;
  slug?: string;
}

interface GroupMember {
  id: string;
  slug?: string;
  compose_service?: string | null;
  member_kind?: string;
}

interface GroupDetail extends GroupSummary {
  applications?: GroupMember[];
}

interface GroupDeploymentSummary {
  id: string;
  deployment_number?: number;
}

function groupsPath(tenantId: string): string {
  return `/tenants/${tenantId}/application-groups/`;
}

async function resolveGroupId(
  client: HttpClient,
  tenantId: string,
  ref: string,
): Promise<string> {
  if (UUID_RE.test(ref)) return ref;
  const groups = await client.get<GroupSummary[]>(groupsPath(tenantId));
  const found = groups.find((g) => g.id === ref || g.slug === ref);
  if (found) return found.id;
  const slugs = groups.map((g) => g.slug ?? g.id).join(", ");
  throw new Error(
    `group '${ref}' not found${slugs ? `. available: ${slugs}` : ""}`,
  );
}

async function resolveMember(
  client: HttpClient,
  tenantId: string,
  groupId: string,
  ref: string,
): Promise<string> {
  const detail = await client.get<GroupDetail>(`${groupsPath(tenantId)}${groupId}`);
  const members = detail.applications ?? [];
  const found = members.find(
    (m) => m.id === ref || m.slug === ref || m.compose_service === ref,
  );
  if (found) return found.id;
  const services = members
    .map((m) => m.compose_service ?? m.slug ?? m.id)
    .join(", ");
  throw new Error(
    `service '${ref}' not found in this group${services ? `. services: ${services}` : ""}`,
  );
}

async function resolveGroupDeploymentId(
  client: HttpClient,
  tenantId: string,
  groupId: string,
  ref: string,
): Promise<string> {
  if (UUID_RE.test(ref)) return ref;
  const page = await client.get<{ items?: GroupDeploymentSummary[] }>(
    `${groupsPath(tenantId)}${groupId}/deployments?limit=100`,
  );
  const n = Number(ref);
  const items = page.items ?? [];
  const found = Number.isInteger(n)
    ? items.find((d) => d.deployment_number === n)
    : undefined;
  if (found) return found.id;
  throw new Error(
    `group deployment '${ref}' not found. Give a deployment number or a group deployment ID.`,
  );
}

export function registerGroupTools(server: McpServer, ctx: McpRegistrationContext): void {
  const groupParam = {
    group: z.string().min(1).describe("Group ID or slug"),
  };
  const serviceParam = {
    service: z
      .string()
      .min(1)
      .describe("Compose service name, member application slug, or application ID"),
  };

  server.tool(
    "list_application_groups",
    "List definition groups (stacks): coordinated compose deployments",
    { ...ctx.orgParam },
    async (args) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const groups = await client.get(groupsPath(tenantId));
        return asToolResult(groups);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_application_group",
    "Get a group's detail including its member applications",
    { ...ctx.orgParam, ...groupParam },
    async ({ group, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const groupId = await resolveGroupId(client, tenantId, group);
        const detail = await client.get(`${groupsPath(tenantId)}${groupId}`);
        return asToolResult(detail);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "list_group_deployments",
    "List coordinated deployments for a group",
    {
      ...ctx.orgParam,
      ...groupParam,
      skip: z.number().int().nonnegative().optional().describe("Pagination offset"),
      limit: z.number().int().positive().optional().describe("Max results (default 20)"),
    },
    async ({ group, skip, limit, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const groupId = await resolveGroupId(client, tenantId, group);
        const params = new URLSearchParams();
        if (skip) params.set("skip", String(skip));
        if (limit) params.set("limit", String(limit));
        const qs = params.toString();
        const page = await client.get(
          `${groupsPath(tenantId)}${groupId}/deployments${qs ? `?${qs}` : ""}`,
        );
        return asToolResult(page);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_group_deployment",
    "Get one group deployment with its stages, per-service slices, and stage log tails",
    {
      ...ctx.orgParam,
      ...groupParam,
      deployment: z.string().min(1).describe("Group deployment number or ID"),
    },
    async ({ group, deployment, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const groupId = await resolveGroupId(client, tenantId, group);
        const gdId = await resolveGroupDeploymentId(client, tenantId, groupId, deployment);
        const detail = await client.get(
          `${groupsPath(tenantId)}${groupId}/deployments/${gdId}`,
        );
        return asToolResult(detail);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "deploy_application_group",
    "Deploy all services of a group as one coordinated group deployment",
    { ...ctx.orgParam, ...groupParam },
    async ({ group, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const groupId = await resolveGroupId(client, tenantId, group);
        const result = await client.post(`${groupsPath(tenantId)}${groupId}/deploy`);
        return asToolResult(result);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "redeploy_group_service",
    "Redeploy one service of a group (a scoped group deployment)",
    { ...ctx.orgParam, ...groupParam, ...serviceParam },
    async ({ group, service, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const groupId = await resolveGroupId(client, tenantId, group);
        const appId = await resolveMember(client, tenantId, groupId, service);
        const result = await client.post(
          `${groupsPath(tenantId)}${groupId}/services/${appId}/redeploy`,
        );
        return asToolResult(result);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "run_group_task",
    "Run a one-shot task member with the stack's env (compose run --rm)",
    { ...ctx.orgParam, ...groupParam, ...serviceParam },
    async ({ group, service, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const groupId = await resolveGroupId(client, tenantId, group);
        const appId = await resolveMember(client, tenantId, groupId, service);
        const run = await client.post(
          `${groupsPath(tenantId)}${groupId}/services/${appId}/run`,
        );
        return asToolResult(run);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "list_group_task_runs",
    "List one-shot task runs for a group",
    {
      ...ctx.orgParam,
      ...groupParam,
      service: z
        .string()
        .min(1)
        .optional()
        .describe("Filter by compose service name, member application slug, or application ID"),
      limit: z.number().int().positive().optional().describe("Max results (default 20)"),
    },
    async ({ group, service, limit, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const groupId = await resolveGroupId(client, tenantId, group);
        const params = new URLSearchParams();
        if (service) {
          params.set("application_id", await resolveMember(client, tenantId, groupId, service));
        }
        if (limit) params.set("limit", String(limit));
        const qs = params.toString();
        const page = await client.get(
          `${groupsPath(tenantId)}${groupId}/task-runs${qs ? `?${qs}` : ""}`,
        );
        return asToolResult(page);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
