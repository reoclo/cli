/**
 * Domain tools: list, inspect, add, verify, and check health.
 * No delete tools (non-destructive guardrails).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpRegistrationContext } from "./context";
import { asToolError, asToolResult } from "./common";

export function registerDomainTools(
  server: McpServer,
  ctx: McpRegistrationContext,
): void {
  const tenantId = ctx.tenantId;
  if (!tenantId) return;

  server.tool(
    "list_domains",
    "List all domains for your tenant",
    {},
    async () => {
      try {
        const domains = await ctx.client.get(`/tenants/${tenantId}/domains/`);
        return asToolResult(domains);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_domain",
    "Get details for a specific domain",
    { domain_id: z.string().min(1).describe("Domain ID") },
    async ({ domain_id }) => {
      try {
        const domain = await ctx.client.get(`/tenants/${tenantId}/domains/${domain_id}`);
        return asToolResult(domain);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_dns_overview",
    "Get DNS record overview for a domain",
    { domain_id: z.string().min(1).describe("Domain ID") },
    async ({ domain_id }) => {
      try {
        const dns = await ctx.client.get(`/tenants/${tenantId}/domains/${domain_id}/dns`);
        return asToolResult(dns);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "check_domain_health",
    "Run DNS and SSL health checks for a domain",
    { domain_id: z.string().min(1).describe("Domain ID") },
    async ({ domain_id }) => {
      try {
        const health = await ctx.client.get(
          `/tenants/${tenantId}/domains/${domain_id}/health`,
        );
        return asToolResult(health);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "add_domain",
    "Register a new domain for your tenant",
    { domain_name: z.string().min(1).describe("Fully qualified domain name") },
    async ({ domain_name }) => {
      try {
        const domain = await ctx.client.post(`/tenants/${tenantId}/domains`, { domain_name });
        return asToolResult(domain);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "verify_domain",
    "Trigger DNS TXT verification for a domain",
    { domain_id: z.string().min(1).describe("Domain ID") },
    async ({ domain_id }) => {
      try {
        const result = await ctx.client.post(
          `/tenants/${tenantId}/domains/${domain_id}/verify`,
          {},
        );
        return asToolResult(result);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
