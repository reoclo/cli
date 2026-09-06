/**
 * Domain tools: list, inspect, add, verify, check health, and preview/publish
 * DNS changes to Cloudflare.
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
    "DNS record overview: the records Reoclo expects per domain, what public DNS answers, per-record status, and the last publish outcome. Pass domain_id for one domain; omit it for every domain in the organization.",
    { ...ctx.orgParam, domain_id: z.string().optional().describe("Domain ID; omit for the whole organization") },
    async ({ domain_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        interface OverviewDomain { domain_id: string }
        interface Overview { servers: { domains: OverviewDomain[] }[]; unbound_domains: OverviewDomain[] }
        const overview = await client.get<Overview>(`/tenants/${tenantId}/dns/overview`);
        if (!domain_id) return asToolResult(overview);
        const all = [...overview.servers.flatMap((s) => s.domains), ...overview.unbound_domains];
        const found = all.find((d) => d.domain_id === domain_id);
        if (!found) return asToolError(new Error(`domain '${domain_id}' has no DNS overview entry`));
        return asToolResult(found);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "check_domain_health",
    "Current DNS, SSL, registration and verification health of a domain, as recorded by the last checks",
    { ...ctx.orgParam, domain_id: z.string().min(1).describe("Domain ID") },
    async ({ domain_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const d = await client.get<Record<string, unknown>>(`/tenants/${tenantId}/domains/${domain_id}`);
        return asToolResult({
          fqdn: d["fqdn"], verification: d["verification"], dns: d["dns"], ssl: d["ssl"], registration: d["registration"],
        });
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

  server.tool(
    "plan_domain_dns",
    "Preview the DNS records Reoclo would write to Cloudflare for a domain (create, update, delete, keep, conflict). Show the result to the user before calling publish_domain_dns; publish needs the plan_hash from this preview.",
    { ...ctx.orgParam, domain_id: z.string().min(1).describe("Domain ID"), proxied: z.boolean().optional().describe("Proxy new records through Cloudflare (default false)") },
    async ({ domain_id, proxied, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const plan = await client.post(`/tenants/${tenantId}/dns/plan/${domain_id}`, { proxied: proxied ?? false });
        return asToolResult(plan);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "publish_domain_dns",
    "Apply a previewed DNS plan on Cloudflare. Requires the plan_hash from plan_domain_dns and the user's explicit confirmation of that preview. The write runs in the background; read the domain's dns.publish block for the outcome.",
    {
      ...ctx.orgParam,
      domain_id: z.string().min(1).describe("Domain ID"),
      plan_hash: z.string().min(8).describe("plan_hash returned by plan_domain_dns"),
      proxied: z.boolean().optional().describe("Proxy new records through Cloudflare (default false)"),
    },
    async ({ domain_id, plan_hash, proxied, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const out = await client.post(`/tenants/${tenantId}/dns/publish/${domain_id}`, { plan_hash, proxied: proxied ?? false });
        return asToolResult(out);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
