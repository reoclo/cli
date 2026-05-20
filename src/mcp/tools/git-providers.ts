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
  const tenantId = ctx.tenantId;
  if (!tenantId) return;

  server.tool(
    "list_git_providers",
    "List all git providers for your organization, optionally filtered by scope",
    {
      scope: z
        .enum(["tenant", "platform", "all"])
        .optional()
        .default("all")
        .describe("Filter by scope: tenant, platform, or all (default)"),
    },
    async ({ scope }) => {
      try {
        const items = await ctx.client.get(`/tenants/${tenantId}/git-providers`);
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
    { provider_id: z.string().min(1).describe("Git provider ID") },
    async ({ provider_id }) => {
      try {
        const provider = await ctx.client.get(
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
      name: z.string().min(2).max(100).describe("Display name for the git provider"),
      slug: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/, "lowercase letters, digits, hyphens only").describe("URL-safe identifier for the provider"),
      instance_url: z.string().url().max(500).describe("Base URL of the Gitea instance"),
      oauth_client_id: z.string().optional().describe("OAuth application client ID"),
      oauth_client_secret: z.string().optional().describe("OAuth application client secret"),
    },
    async ({ name, slug, instance_url, oauth_client_id, oauth_client_secret }) => {
      try {
        const created = await ctx.client.post(
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
    { provider_id: z.string().min(1).describe("Git provider ID") },
    async ({ provider_id }) => {
      try {
        const res = await ctx.client.post(
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
    { provider_id: z.string().min(1).describe("Git provider ID") },
    async ({ provider_id }) => {
      try {
        const res = await ctx.client.post(
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
    { provider_id: z.string().min(1).describe("Git provider ID") },
    async ({ provider_id }) => {
      try {
        const status = await ctx.client.get(
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
    { provider_id: z.string().min(1).describe("Git provider ID") },
    async ({ provider_id }) => {
      try {
        await ctx.client.del(
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
    { provider_id: z.string().min(1).describe("Git provider ID") },
    async ({ provider_id }) => {
      try {
        const orgs = await ctx.client.get(
          `/tenants/${tenantId}/git-providers/${provider_id}/organizations`,
        );
        return asToolResult(orgs);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
