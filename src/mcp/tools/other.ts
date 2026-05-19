/**
 * Miscellaneous tools: repos, env vars, registry creds, audit, dashboard.
 * Credentials are always masked in responses.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpRegistrationContext } from "./context";
import { asToolError, asToolResult } from "./common";

export function registerOtherTools(
  server: McpServer,
  ctx: McpRegistrationContext,
): void {
  const tenantId = ctx.tenantId;
  if (!tenantId) return;

  // Repositories
  server.tool(
    "list_repositories",
    "List connected Git repositories",
    {},
    async () => {
      try {
        const repos = await ctx.client.get(`/tenants/${tenantId}/repositories/`);
        return asToolResult(repos);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_repository",
    "Get a single connected Git repository by id.",
    { repository_id: z.string().min(1).describe("Repository id") },
    async ({ repository_id }) => {
      try {
        const repo = await ctx.client.get(
          `/tenants/${tenantId}/repositories/${repository_id}`,
        );
        return asToolResult(repo);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "list_repo_branches",
    "List branches for a repository.",
    { repository_id: z.string().min(1).describe("Repository id") },
    async ({ repository_id }) => {
      try {
        const branches = await ctx.client.get(
          `/tenants/${tenantId}/repositories/${repository_id}/branches`,
        );
        return asToolResult(branches);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  // Environment variables (values masked)
  server.tool(
    "list_env_vars",
    "List environment variable keys for an application (values are masked)",
    { application_id: z.string().min(1).describe("Application ID") },
    async ({ application_id }) => {
      try {
        const envVars = await ctx.client.get(
          `/tenants/${tenantId}/applications/${application_id}/env`,
        );
        return asToolResult(envVars);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "set_env_var",
    "Set or update an environment variable for an application",
    {
      application_id: z.string().min(1).describe("Application ID"),
      key: z.string().min(1).describe("Variable name"),
      value: z.string().describe("Variable value"),
    },
    async ({ application_id, key, value }) => {
      try {
        const result = await ctx.client.post(
          `/tenants/${tenantId}/applications/${application_id}/env`,
          { key, value },
        );
        return asToolResult(result);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  // Registry credentials (masked)
  server.tool(
    "list_registry_creds",
    "List container registry credentials (passwords are masked)",
    {},
    async () => {
      try {
        const creds = await ctx.client.get(`/tenants/${tenantId}/registry-credentials/`);
        return asToolResult(creds);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_registry_cred",
    "Get a single container registry credential by id (password masked).",
    { credential_id: z.string().min(1).describe("Registry credential id") },
    async ({ credential_id }) => {
      try {
        const cred = await ctx.client.get(
          `/tenants/${tenantId}/registry-credentials/${credential_id}`,
        );
        return asToolResult(cred);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "create_registry_cred",
    "Create a container registry credential.",
    {
      name: z.string().min(1).describe("Human-readable name (e.g. 'dockerhub-prod')"),
      registry_type: z.enum(["docker", "ecr", "private"]).describe("Registry kind"),
      registry_url: z.string().url().describe("Registry URL"),
      encrypted_credential: z.string().min(1).describe(
        "The credential/password value. Sensitive — treat as such and do not echo back to the user.",
      ),
      username: z.string().optional().describe("Registry username, if applicable"),
      description: z.string().optional().describe("Description"),
    },
    async ({ name, registry_type, registry_url, encrypted_credential, username, description }) => {
      try {
        const body: Record<string, unknown> = {
          name,
          registry_type,
          registry_url,
          encrypted_credential,
        };
        if (username !== undefined) body["username"] = username;
        if (description !== undefined) body["description"] = description;
        const created = await ctx.client.post(
          `/tenants/${tenantId}/registry-credentials/`,
          body,
        );
        return asToolResult(created);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "update_registry_cred",
    "Update fields of an existing container registry credential.",
    {
      credential_id: z.string().min(1).describe("Registry credential id"),
      name: z.string().optional().describe("New name"),
      registry_url: z.string().url().optional().describe("New URL"),
      username: z.string().optional().describe("New username"),
      description: z.string().optional().describe("New description"),
      encrypted_credential: z.string().min(1).optional().describe(
        "New credential/password value. Sensitive — treat as such.",
      ),
    },
    async ({ credential_id, name, registry_url, username, description, encrypted_credential }) => {
      try {
        const body: Record<string, unknown> = {};
        if (name !== undefined) body["name"] = name;
        if (registry_url !== undefined) body["registry_url"] = registry_url;
        if (username !== undefined) body["username"] = username;
        if (description !== undefined) body["description"] = description;
        if (encrypted_credential !== undefined) body["encrypted_credential"] = encrypted_credential;
        const updated = await ctx.client.patch(
          `/tenants/${tenantId}/registry-credentials/${credential_id}`,
          body,
        );
        return asToolResult(updated);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "test_registry_cred",
    "Test a registry connection ad-hoc (does not require an existing credential record).",
    {
      registry_type: z.enum(["docker", "ecr", "private"]).describe("Registry kind"),
      registry_url: z.string().url().describe("Registry URL"),
      encrypted_credential: z.string().min(1).describe(
        "The credential/password to test. Sensitive — treat as such.",
      ),
      username: z.string().optional().describe("Registry username, if applicable"),
    },
    async ({ registry_type, registry_url, encrypted_credential, username }) => {
      try {
        const body: Record<string, unknown> = {
          registry_type,
          registry_url,
          encrypted_credential,
        };
        if (username !== undefined) body["username"] = username;
        const result = await ctx.client.post(
          `/tenants/${tenantId}/registry-credentials/test-connection`,
          body,
        );
        // success:false is a normal business-logic result, NOT an MCP error.
        return asToolResult(result);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  // Audit logs
  server.tool(
    "get_audit_log",
    "Get recent audit log entries for your organization",
    {
      limit: z.number().int().positive().optional().describe("Max entries (default 50)"),
      action: z.string().optional().describe("Filter by action type"),
      resource_type: z.string().optional().describe("Filter by resource type"),
    },
    async ({ limit, action, resource_type }) => {
      try {
        const params = new URLSearchParams();
        if (limit) params.set("limit", String(limit));
        if (action) params.set("action", action);
        if (resource_type) params.set("resource_type", resource_type);
        const qs = params.toString();
        const logs = await ctx.client.get(`/tenants/${tenantId}/audit-logs${qs ? `?${qs}` : ""}`);
        return asToolResult(logs);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  // Dashboard
  server.tool(
    "get_dashboard",
    "Get a summary dashboard with counts and health overview",
    {},
    async () => {
      try {
        const dashboard = await ctx.client.get(`/tenants/${tenantId}/dashboard/stats`);
        return asToolResult(dashboard);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
