/**
 * Server tools: server inspection and health checks, the proxy IP allowlist,
 * and server setup. Setup and hardening need root on the server, so those tools
 * only produce what a person or agent then runs. Decommissioning is the one
 * destructive tool and must name the server's slug. No create/reboot tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpRegistrationContext } from "./context";
import { asToolError, asToolResult, ipAllowlistSchema } from "./common";
import { ApiError } from "../../client/errors";
import {
  buildHardenCliCommand,
  buildSetupCommand,
  parseAdminUser,
  parseFirewallPorts,
  parseHostname,
  parseTrustedIps,
  portsBlockedByHardening,
  scannedPorts,
  type PortScan,
} from "../../client/server-setup";

interface RunnerTokenResponse {
  token: { id: string; expires_at: string };
  plaintext_token: string;
  runner_gateway_url: string | null;
  runner_install_url: string | null;
}

const firewallAllowSchema = z
  .array(z.string().min(1))
  .max(50)
  .optional()
  .describe("Extra ports to open through the firewall, for example 8080, 8080/tcp or 9000:9100/udp");
const trustedIpsSchema = z
  .array(z.string().min(1))
  .max(50)
  .optional()
  .describe("Addresses or CIDR ranges that fail2ban never bans");

export function registerServerTools(
  server: McpServer,
  ctx: McpRegistrationContext,
): void {
  server.tool(
    "list_servers",
    "List all servers in an organization",
    { ...ctx.orgParam },
    async (args) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const servers = await client.get(`/tenants/${tenantId}/servers/`);
        return asToolResult(servers);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_server",
    "Get detailed info for a specific server",
    { ...ctx.orgParam, server_id: z.string().min(1).describe("Server ID") },
    async ({ server_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const detail = await client.get(`/tenants/${tenantId}/servers/${server_id}`);
        return asToolResult(detail);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_server_metrics",
    "Get current resource metrics (CPU, memory, disk) for a server",
    { ...ctx.orgParam, server_id: z.string().min(1).describe("Server ID") },
    async ({ server_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const metrics = await client.get(`/tenants/${tenantId}/servers/${server_id}/metrics`);
        return asToolResult(metrics);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_server_health",
    "Get the latest health status for a server",
    { ...ctx.orgParam, server_id: z.string().min(1).describe("Server ID") },
    async ({ server_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const health = await client.get(`/tenants/${tenantId}/servers/${server_id}/health`);
        return asToolResult(health);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "list_containers",
    "List Docker containers running on a server",
    { ...ctx.orgParam, server_id: z.string().min(1).describe("Server ID") },
    async ({ server_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const containers = await client.get(
          `/tenants/${tenantId}/servers/${server_id}/containers`,
        );
        return asToolResult(containers);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "inspect_container",
    "Get detailed info about a specific container",
    {
      ...ctx.orgParam,
      server_id: z.string().min(1).describe("Server ID"),
      container_id: z.string().min(1).describe("Container ID"),
    },
    async ({ server_id, container_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const container = await client.get(
          `/tenants/${tenantId}/servers/${server_id}/containers/${container_id}`,
        );
        return asToolResult(container);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_container_logs",
    "Get recent logs from a container",
    {
      ...ctx.orgParam,
      server_id: z.string().min(1).describe("Server ID"),
      container_id: z.string().min(1).describe("Container ID"),
      tail: z.number().int().positive().optional().describe("Number of lines (default 100)"),
      since: z.string().optional().describe("Start time (ISO 8601), only return logs after this time"),
    },
    async ({ server_id, container_id, tail, since, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const params = new URLSearchParams();
        if (tail) params.set("tail", String(tail));
        if (since) params.set("since", since);
        const qs = params.toString();
        const logs = await client.get(
          `/tenants/${tenantId}/servers/${server_id}/containers/${container_id}/logs${qs ? `?${qs}` : ""}`,
        );
        return asToolResult(logs);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "get_server_uptime",
    "Get server connectivity graph (uptime history as time-slot buckets). Returns status per slot: healthy, unhealthy, grace, or no_data.",
    {
      ...ctx.orgParam,
      server_id: z.string().min(1).describe("Server ID"),
      hours: z.number().int().min(1).max(168).default(6).describe("Hours of history (default 6)"),
      slot_minutes: z.number().int().min(1).max(60).default(2).describe("Slot width in minutes (default 2)"),
    },
    async ({ server_id, hours, slot_minutes, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const params = new URLSearchParams({ hours: String(hours), slot_minutes: String(slot_minutes) });
        const result = await client.get(
          `/tenants/${tenantId}/servers/${server_id}/uptime?${params.toString()}`,
        );
        return asToolResult(result);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "port_scan",
    "Scan open ports on a server",
    { ...ctx.orgParam, server_id: z.string().min(1).describe("Server ID") },
    async ({ server_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const ports = await client.get(`/tenants/${tenantId}/servers/${server_id}/ports`);
        return asToolResult(ports);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "check_server_health",
    "Trigger an on-demand health check for a server",
    { ...ctx.orgParam, server_id: z.string().min(1).describe("Server ID") },
    async ({ server_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const result = await client.post(
          `/tenants/${tenantId}/servers/${server_id}/health-check`,
          {},
        );
        return asToolResult(result);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "set_server_ip_allowlist",
    "Set the server's default IP allowlist, which domains on it inherit, or remove it (clear: true). Only applies on servers running the managed proxy; the API returns 409 otherwise. Domains with their own allowlist keep it; domains set to inherit follow this default.",
    {
      ...ctx.orgParam,
      server_id: z.string().min(1).describe("Server ID"),
      ip_allowlist: ipAllowlistSchema.optional(),
      clear: z.boolean().optional().describe("true to remove the server's default allowlist"),
    },
    async ({ server_id, ip_allowlist, clear, ...args }) => {
      try {
        if ((ip_allowlist === undefined) === (clear !== true)) {
          throw new Error("Pass either ip_allowlist or clear: true.");
        }
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const result = await client.put(
          `/tenants/${tenantId}/servers/${server_id}/proxy/ip-allowlist`,
          { ip_allowlist: clear === true ? null : ip_allowlist },
        );
        return asToolResult(result);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "create_server_setup_script",
    "Create the script that turns a fresh Ubuntu 22.04+ or Debian 12+ server into a Reoclo server: admin user, rootless Docker, the runner, and hardening. Nothing runs from here: a person runs it on the server as root or with sudo, or passes it as cloud-init user data, and the server then appears in list_servers. The script holds a single-use registration token valid for one hour, so give it only to whoever is setting up the server.",
    {
      ...ctx.orgParam,
      target: z
        .enum(["shell", "cloud-init"])
        .optional()
        .describe("shell (default) to paste over SSH; cloud-init for first-boot user data"),
      admin_user: z.string().min(1).optional().describe("Admin user that runs Docker and the runner (default ubuntu)"),
      name: z.string().min(1).max(120).describe("Name shown for the server, which also sets its slug"),
      hostname: z.string().min(1).optional().describe("Hostname to register the server under"),
      harden: z
        .boolean()
        .optional()
        .describe("Default true: no root or password SSH logins, default-deny firewall, fail2ban, automatic security updates"),
      firewall_allow: firewallAllowSchema,
      trusted_ips: trustedIpsSchema,
    },
    async ({ target, admin_user, name, hostname, harden, firewall_allow, trusted_ips, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const options = {
          adminUser: parseAdminUser(admin_user ?? "ubuntu"),
          hostname: hostname === undefined ? undefined : parseHostname(hostname),
          harden: harden ?? true,
          firewallAllow: parseFirewallPorts(firewall_allow ?? []),
          trustedIps: parseTrustedIps(trusted_ips ?? []),
        };
        const created = await client.post<RunnerTokenResponse>(
          `/admin/runners/tokens?tenant_id=${tenantId}`,
          { label: name },
        );
        if (!created.runner_install_url) {
          throw new Error("Runner install URL is not configured on this deployment.");
        }
        return asToolResult({
          script: buildSetupCommand(
            {
              ...options,
              installUrl: created.runner_install_url.replace(/\/+$/, ""),
              token: created.plaintext_token,
              gatewayUrl: created.runner_gateway_url,
            },
            target === "cloud-init" ? "cloud-init" : "paste",
          ),
          token_id: created.token.id,
          expires_at: created.token.expires_at,
        });
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "plan_server_hardening",
    "Plan hardening for a connected server without changing it. Scans its listening ports, reports which ones the firewall would block, and returns the `reoclo servers harden` command to run. Hardening needs root over SSH, so a person or an agent with a shell runs that command. It disables root and password SSH logins, so add --yes only after the user has confirmed.",
    {
      ...ctx.orgParam,
      server_id: z.string().min(1).describe("Server ID"),
      admin_user: z.string().min(1).optional().describe("Admin user that must keep SSH access (default ubuntu)"),
      ssh_only: z.boolean().optional().describe("Lock down SSH only: no firewall, fail2ban or automatic updates"),
      firewall_allow: firewallAllowSchema,
      trusted_ips: trustedIpsSchema,
    },
    async ({ server_id, admin_user, ssh_only, firewall_allow, trusted_ips, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const adminUser = admin_user === undefined ? undefined : parseAdminUser(admin_user);
        const firewallAllow = parseFirewallPorts(firewall_allow ?? []);
        const trustedIps = parseTrustedIps(trusted_ips ?? []);
        const srv = await client.get<{ slug: string }>(`/tenants/${tenantId}/servers/${server_id}`);
        let blockedPorts: number[] = [];
        let portScanError: string | undefined;
        if (!ssh_only) {
          try {
            const scan = await client.get<PortScan>(`/tenants/${tenantId}/servers/${server_id}/ports`);
            blockedPorts = portsBlockedByHardening(scannedPorts(scan), firewallAllow);
          } catch (error: unknown) {
            if (!(error instanceof ApiError)) throw error;
            portScanError = error.message;
          }
        }
        return asToolResult({
          server: srv.slug,
          blocked_ports: blockedPorts,
          ...(portScanError === undefined ? {} : { port_scan_error: portScanError }),
          command: buildHardenCliCommand(srv.slug, { adminUser, sshOnly: ssh_only, firewallAllow, trustedIps }),
        });
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "decommission_server",
    "Decommission a server: its runner disconnects and it can no longer be deployed to. The API refuses while applications are assigned to it. Call this only after the user has confirmed this exact server.",
    {
      ...ctx.orgParam,
      server_id: z.string().min(1).describe("Server ID"),
      confirm_slug: z.string().min(1).describe("The server's slug, which must match the server being decommissioned"),
    },
    async ({ server_id, confirm_slug, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const srv = await client.get<{ slug: string }>(`/tenants/${tenantId}/servers/${server_id}`);
        if (srv.slug !== confirm_slug) {
          throw new Error(`confirm_slug '${confirm_slug}' does not match server slug '${srv.slug}'.`);
        }
        await client.del(`/tenants/${tenantId}/servers/${server_id}`);
        return asToolResult({ id: server_id, slug: srv.slug, decommissioned: true });
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "restart_container",
    "Restart a specific Docker container on a server",
    {
      ...ctx.orgParam,
      server_id: z.string().min(1).describe("Server ID"),
      container_id: z.string().min(1).describe("Container ID"),
    },
    async ({ server_id, container_id, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const result = await client.post(
          `/tenants/${tenantId}/servers/${server_id}/containers/${container_id}/restart`,
          {},
        );
        return asToolResult(result);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );

  server.tool(
    "exec_command",
    "Run a shell command on a server for diagnostics. Commands run as the runner service account. Elevated commands limited to the runner's sudoers whitelist. Max timeout is 300s.",
    {
      ...ctx.orgParam,
      server_id: z.string().min(1).describe("Server ID"),
      command: z.string().min(1).describe("Shell command to execute"),
      timeout: z.number().int().min(5).max(300).optional().describe("Timeout in seconds (default 60)"),
    },
    async ({ server_id, command, timeout, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const result = await client.post(
          `/tenants/${tenantId}/servers/${server_id}/exec`,
          { command, timeout: timeout ?? 60 },
        );
        return asToolResult(result);
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
