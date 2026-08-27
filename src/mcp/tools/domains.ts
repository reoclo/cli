/**
 * Domain tools: list, inspect, add, verify, and check health.
 * No delete tools (non-destructive guardrails).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpRegistrationContext } from "./context";
import { asToolError, asToolResult } from "./common";

export function registerDomainTools(server: McpServer, ctx: McpRegistrationContext): void {
  server.tool(
    "list_domains",
    "List all domains for an organization",
    { ...ctx.orgParam },
    async (args) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const domains = await client.get(`/tenants/${tenantId}/domains/`);
        return asToolResult(domains);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_domain",
    "Get details for a specific domain",
    { ...ctx.orgParam, domain_id: z.string().min(1).describe("Domain ID") },
    async ({ domain_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const domain = await client.get(`/tenants/${tenantId}/domains/${domain_id}`);
        return asToolResult(domain);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_dns_overview",
    "Get DNS record overview for a domain",
    { ...ctx.orgParam, domain_id: z.string().min(1).describe("Domain ID") },
    async ({ domain_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const dns = await client.get(`/tenants/${tenantId}/domains/${domain_id}/dns`);
        return asToolResult(dns);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "check_domain_health",
    "Run DNS and SSL health checks for a domain",
    { ...ctx.orgParam, domain_id: z.string().min(1).describe("Domain ID") },
    async ({ domain_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const health = await client.get(`/tenants/${tenantId}/domains/${domain_id}/health`);
        return asToolResult(health);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "add_domain",
    "Add a domain to an organization, optionally linking it to an application. A verified root domain that has no application yet is linked in place rather than duplicated.",
    {
      ...ctx.orgParam,
      fqdn: z
        .string()
        .min(1)
        .describe("Fully qualified domain name, e.g. app.example.com or the bare root example.com"),
      application_id: z.string().optional().describe("Application to link the domain to"),
      bound_server_id: z
        .string()
        .optional()
        .describe("Server that serves the domain; its IP becomes the expected A record"),
      target_port: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Container port to route to; must be one of the application's declared ports"),
    },
    async ({ fqdn, application_id, bound_server_id, target_port, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        // Only send what the caller set: the API keeps an adopted record's
        // stored values for fields the payload omits.
        const body: Record<string, unknown> = { fqdn };
        if (application_id !== undefined) body["application_id"] = application_id;
        if (bound_server_id !== undefined) body["bound_server_id"] = bound_server_id;
        if (target_port !== undefined) body["target_port"] = target_port;
        const domain = await client.post(`/tenants/${tenantId}/domains/`, body);
        return asToolResult(domain);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "verify_domain",
    "Trigger DNS TXT verification for a domain",
    { ...ctx.orgParam, domain_id: z.string().min(1).describe("Domain ID") },
    async ({ domain_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const result = await client.post(`/tenants/${tenantId}/domains/${domain_id}/verify`, {});
        return asToolResult(result);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
