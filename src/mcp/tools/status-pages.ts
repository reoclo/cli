/**
 * Status page tools: build a page, manage the components on it, put it on a
 * custom hostname, and run incidents.
 *
 * No delete tools (non-destructive guardrails). Hiding a component and pinning
 * its status are both reversible, so those are exposed instead.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpRegistrationContext } from "./context";
import { asToolError, asToolResult } from "./common";

const COMPONENT_SOURCE_KINDS = ["domain", "server", "application", "monitor", "manual"] as const;

const COMPONENT_STATUSES = [
  "operational",
  "degraded_performance",
  "partial_outage",
  "major_outage",
  "maintenance",
  "unknown",
] as const;

interface VerifiedDomain {
  id: string;
  root_domain: string;
  status: string;
}

/** Longest matching root wins, so "eu.acme.com" beats "acme.com" for a host under both. */
function matchRootDomain(list: VerifiedDomain[], hostname: string): VerifiedDomain | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  const matches = list.filter((d) => {
    const root = d.root_domain.trim().toLowerCase();
    return host === root || host.endsWith(`.${root}`);
  });
  if (matches.length === 0) return null;
  return matches.reduce((best, d) => (d.root_domain.length > best.root_domain.length ? d : best));
}

export function registerStatusPageTools(
  server: McpServer,
  ctx: McpRegistrationContext,
): void {
  const tenantId = ctx.tenantId;
  if (!tenantId) return;

  const pages = `/tenants/${tenantId}/status-pages`;

  server.tool(
    "list_status_pages",
    "List all status pages for your organization",
    {},
    async () => {
      try {
        return asToolResult(await ctx.client.get(`${pages}/`));
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_status_page",
    "Get a status page with its components and active incidents",
    { status_page_id: z.string().min(1).describe("Status page ID") },
    async ({ status_page_id }) => {
      try {
        return asToolResult(await ctx.client.get(`${pages}/${status_page_id}`));
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "create_status_page",
    "Create a status page. New pages are published by default. To add components before anyone can see the page, first call update_status_page with is_published false.",
    {
      title: z.string().min(1).max(80).describe("Page title shown to visitors"),
      label: z.string().max(120).optional().describe("Short label"),
      description: z.string().optional().describe("Page description"),
    },
    async ({ title, label, description }) => {
      try {
        return asToolResult(
          await ctx.client.post(`${pages}/`, {
            title,
            ...(label !== undefined ? { label } : {}),
            ...(description !== undefined ? { description } : {}),
          }),
        );
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "update_status_page",
    "Update a status page's title, label, description, or published state",
    {
      status_page_id: z.string().min(1).describe("Status page ID"),
      title: z.string().min(1).max(80).optional().describe("Page title"),
      label: z.string().max(120).optional().describe("Short label"),
      description: z.string().optional().describe("Page description"),
      is_published: z
        .boolean()
        .optional()
        .describe("Whether the page is visible to the public"),
    },
    async ({ status_page_id, title, label, description, is_published }) => {
      try {
        const body: Record<string, unknown> = {};
        if (title !== undefined) body.title = title;
        if (label !== undefined) body.label = label;
        if (description !== undefined) body.description = description;
        if (is_published !== undefined) body.is_published = is_published;
        return asToolResult(await ctx.client.patch(`${pages}/${status_page_id}`, body));
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "list_verified_domains",
    "List root domains this organization has proven it owns. A status page custom hostname must sit under one of these. This is not the same resource as list_domains.",
    {},
    async () => {
      try {
        return asToolResult(await ctx.client.get(`/tenants/${tenantId}/verified-domains/`));
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "link_status_page_domain",
    "Serve a status page on a custom hostname. The hostname must sit under a verified root domain, which is found automatically. Pass an empty hostname to unlink.",
    {
      status_page_id: z.string().min(1).describe("Status page ID"),
      hostname: z
        .string()
        .describe("Hostname such as status.example.com, or '' to remove the custom hostname"),
    },
    async ({ status_page_id, hostname }) => {
      try {
        const host = hostname.trim().toLowerCase();
        if (host === "") {
          return asToolResult(
            await ctx.client.patch(`${pages}/${status_page_id}`, {
              domain_id: null,
              custom_hostname: null,
            }),
          );
        }
        const verified = await ctx.client.get<VerifiedDomain[]>(
          `/tenants/${tenantId}/verified-domains/`,
        );
        const root = matchRootDomain(verified, host);
        if (!root) {
          return asToolError(
            new Error(
              `No verified root domain covers '${host}'. Claim and verify the root domain first.`,
            ),
          );
        }
        if (root.status !== "verified") {
          return asToolError(
            new Error(
              `Root domain '${root.root_domain}' is not verified yet (status: ${root.status}).`,
            ),
          );
        }
        return asToolResult(
          await ctx.client.patch(`${pages}/${status_page_id}`, {
            domain_id: root.id,
            custom_hostname: host,
          }),
        );
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "list_status_components",
    "List the components shown on a status page, in display order",
    { status_page_id: z.string().min(1).describe("Status page ID") },
    async ({ status_page_id }) => {
      try {
        return asToolResult(await ctx.client.get(`${pages}/${status_page_id}/components/`));
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "create_status_component",
    "Add a component to a status page. A component either mirrors another resource (source_kind domain/server/application/monitor plus ref_id) or is driven by hand (source_kind manual).",
    {
      status_page_id: z.string().min(1).describe("Status page ID"),
      name: z.string().min(1).max(80).describe("Component name shown to visitors"),
      source_kind: z
        .enum(COMPONENT_SOURCE_KINDS)
        .describe("What the component watches"),
      ref_id: z
        .string()
        .optional()
        .describe("ID of the watched resource. Required unless source_kind is 'manual'."),
      position: z.number().int().min(0).optional().describe("Sort order on the page"),
      is_visible: z.boolean().optional().describe("Whether visitors can see it (default true)"),
      health_check_url: z
        .string()
        .optional()
        .describe("Poll this URL to derive the component's status"),
      health_check_interval_seconds: z
        .number()
        .int()
        .min(10)
        .max(3600)
        .optional()
        .describe("Seconds between health checks (default 60)"),
    },
    async ({
      status_page_id,
      name,
      source_kind,
      ref_id,
      position,
      is_visible,
      health_check_url,
      health_check_interval_seconds,
    }) => {
      try {
        if (source_kind !== "manual" && !ref_id) {
          return asToolError(new Error(`ref_id is required when source_kind is '${source_kind}'`));
        }
        if (source_kind === "manual" && ref_id) {
          return asToolError(new Error("ref_id must be omitted when source_kind is 'manual'"));
        }
        const body: Record<string, unknown> = {
          name,
          source: { kind: source_kind, ref_id: source_kind === "manual" ? null : ref_id },
        };
        if (position !== undefined) body.position = position;
        if (is_visible !== undefined) body.is_visible = is_visible;
        if (health_check_url !== undefined) {
          body.health_check = {
            enabled: true,
            url: health_check_url,
            interval_seconds: health_check_interval_seconds ?? 60,
            expected_status_min: 200,
            expected_status_max: 299,
            timeout_seconds: 10,
          };
        }
        return asToolResult(
          await ctx.client.post(`${pages}/${status_page_id}/components/`, body),
        );
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "update_status_component",
    "Rename a component, move it in the display order, or show and hide it",
    {
      status_page_id: z.string().min(1).describe("Status page ID"),
      component_id: z.string().min(1).describe("Component ID"),
      name: z.string().min(1).max(80).optional().describe("Component name"),
      position: z.number().int().min(0).optional().describe("Sort order on the page"),
      is_visible: z.boolean().optional().describe("Whether visitors can see it"),
    },
    async ({ status_page_id, component_id, name, position, is_visible }) => {
      try {
        const body: Record<string, unknown> = {};
        if (name !== undefined) body.name = name;
        if (position !== undefined) body.position = position;
        if (is_visible !== undefined) body.is_visible = is_visible;
        return asToolResult(
          await ctx.client.patch(`${pages}/${status_page_id}/components/${component_id}`, body),
        );
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "set_status_component_status",
    "Pin what visitors see for a component, overriding the status derived from its source. Set pinned to false to go back to the derived status.",
    {
      status_page_id: z.string().min(1).describe("Status page ID"),
      component_id: z.string().min(1).describe("Component ID"),
      pinned: z
        .boolean()
        .describe("True to pin the status, false to clear an existing pin"),
      status: z
        .enum(COMPONENT_STATUSES)
        .optional()
        .describe("Status to pin. Required when pinned is true."),
      reason: z.string().optional().describe("Reason shown alongside the pinned status"),
      until: z
        .string()
        .optional()
        .describe("ISO 8601 timestamp at which the pin clears itself"),
    },
    async ({ status_page_id, component_id, pinned, status, reason, until }) => {
      try {
        if (pinned && !status) {
          return asToolError(new Error("status is required when pinned is true"));
        }
        const override = pinned
          ? {
              enabled: true,
              status,
              reason: reason ?? null,
              suppress_auto_incidents: true,
              until: until ?? null,
            }
          : {
              enabled: false,
              status: null,
              reason: null,
              suppress_auto_incidents: true,
              until: null,
            };
        return asToolResult(
          await ctx.client.patch(`${pages}/${status_page_id}/components/${component_id}`, {
            override,
          }),
        );
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "create_incident",
    "Create a new incident on a status page",
    {
      status_page_id: z.string().min(1).describe("Status page ID"),
      title: z.string().min(1).describe("Incident title"),
      message: z.string().min(1).describe("Initial status message"),
      severity: z.string().min(1).describe("Severity: minor, major, critical"),
    },
    async ({ status_page_id, title, message, severity }) => {
      try {
        const incident = await ctx.client.post(
          `${pages}/${status_page_id}/incidents`,
          { title, message, severity },
        );
        return asToolResult(incident);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "update_incident",
    "Update an incident's status and add a message",
    {
      incident_id: z.string().min(1).describe("Incident ID"),
      status: z.string().min(1).describe("New status: investigating, identified, monitoring, resolved"),
      message: z.string().optional().describe("Status update message"),
    },
    async ({ incident_id, status, message }) => {
      try {
        const updated = await ctx.client.patch(
          `/tenants/${tenantId}/incidents/${incident_id}`,
          { status, ...(message ? { message } : {}) },
        );
        return asToolResult(updated);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
