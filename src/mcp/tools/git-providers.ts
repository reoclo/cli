/**
 * Git provider tools: list, inspect, create, test, sync, and delete git providers.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpRegistrationContext } from "./context";
import { asToolError, asToolResult } from "./common";

export function registerGitProviderTools(
  server: McpServer,
  ctx: McpRegistrationContext,
): void {
  server.tool(
    "list_git_providers",
    "List all git providers for an organization, optionally filtered by scope",
    {
      ...ctx.orgParam,
      scope: z
        .enum(["tenant", "platform", "all"])
        .optional()
        .default("all")
        .describe("Filter by scope: tenant, platform, or all (default)"),
    },
    async ({ scope, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const items = await client.get(`/tenants/${tenantId}/git-providers`);
        const list = Array.isArray(items) ? (items as Array<{ scope: string }>) : [];
        const filtered = scope === "all" ? items : list.filter((p) => p.scope === scope);
        return asToolResult(filtered);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_git_provider",
    "Get details for a specific git provider",
    { ...ctx.orgParam, provider_id: z.string().min(1).describe("Git provider ID") },
    async ({ provider_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const provider = await client.get(
          `/tenants/${tenantId}/git-providers/${provider_id}`,
        );
        return asToolResult(provider);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "create_git_provider",
    "Create a new tenant-scoped Gitea git provider. Other provider types (e.g. GitHub) and platform-scoped providers must be configured outside this tool. Optional `api_url`, `webhook_secret`, `config`, and `allowed_organizations` fields are not exposed here — use the REST API directly if you need them.",
    {
      ...ctx.orgParam,
      name: z.string().min(2).max(100).describe("Display name for the git provider"),
      slug: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/, "lowercase letters, digits, hyphens only").describe("URL-safe identifier for the provider"),
      instance_url: z.string().url().max(500).describe("Base URL of the Gitea instance"),
      oauth_client_id: z.string().optional().describe("OAuth application client ID"),
      oauth_client_secret: z.string().optional().describe("OAuth application client secret"),
    },
    async ({ name, slug, instance_url, oauth_client_id, oauth_client_secret, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const created = await client.post(
          `/tenants/${tenantId}/git-providers`,
          {
            provider_type: "gitea",
            scope: "tenant",
            name,
            slug,
            instance_url,
            ...(oauth_client_id ? { oauth_client_id } : {}),
            ...(oauth_client_secret ? { oauth_client_secret } : {}),
          },
        );
        return asToolResult(created);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "test_git_provider",
    "Test connectivity for a git provider",
    { ...ctx.orgParam, provider_id: z.string().min(1).describe("Git provider ID") },
    async ({ provider_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const res = await client.post(
          `/tenants/${tenantId}/git-providers/${provider_id}/test-connection`,
          {},
        );
        return asToolResult(res);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "sync_git_provider",
    "Trigger a sync for a git provider to refresh repositories and organizations",
    { ...ctx.orgParam, provider_id: z.string().min(1).describe("Git provider ID") },
    async ({ provider_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const res = await client.post(
          `/tenants/${tenantId}/git-providers/${provider_id}/sync`,
          {},
        );
        return asToolResult(res);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_provider_sync_status",
    "Get the sync status for a git provider",
    { ...ctx.orgParam, provider_id: z.string().min(1).describe("Git provider ID") },
    async ({ provider_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const status = await client.get(
          `/tenants/${tenantId}/git-providers/${provider_id}/sync-status`,
        );
        return asToolResult(status);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "delete_git_provider",
    "Permanently delete a git provider and disconnect it from all associated applications. Repositories already synced are not removed, but applications referencing them lose their repository link. This action cannot be undone.",
    { ...ctx.orgParam, provider_id: z.string().min(1).describe("Git provider ID") },
    async ({ provider_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        await client.del(
          `/tenants/${tenantId}/git-providers/${provider_id}`,
        );
        return asToolResult({ success: true, provider_id });
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "list_provider_organizations",
    "List organizations accessible via a git provider",
    { ...ctx.orgParam, provider_id: z.string().min(1).describe("Git provider ID") },
    async ({ provider_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const orgs = await client.get(
          `/tenants/${tenantId}/git-providers/${provider_id}/organizations`,
        );
        return asToolResult(orgs);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
