/**
 * Status page tools: view pages and manage incidents.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpRegistrationContext } from "./context";
import { asToolError, asToolResult } from "./common";

export function registerStatusPageTools(
  server: McpServer,
  ctx: McpRegistrationContext,
): void {
  const tenantId = ctx.tenantId;
  if (!tenantId) return;

  server.tool(
    "list_status_pages",
    "List all status pages for your tenant",
    {},
    async () => {
      try {
        const pages = await ctx.client.get(`/tenants/${tenantId}/status-pages/`);
        return asToolResult(pages);
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
        const page = await ctx.client.get(
          `/tenants/${tenantId}/status-pages/${status_page_id}`,
        );
        return asToolResult(page);
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
          `/tenants/${tenantId}/status-pages/${status_page_id}/incidents`,
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
