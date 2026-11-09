// src/tunnels/directory.ts
//
// What the daemon asks the Reoclo API for: the organizations of the signed-in
// profile, an organization's servers and their stored port scans, and the ids
// an ad-hoc tunnel needs. Errors become ManagerErrors so the control API
// answers 401, 403 or 404 instead of a bare 500.

import { bootstrap, isEnvCredential, requireTenantId, type BootstrapOptions, type ResolvedContext } from "../client/bootstrap";
import { ApiError } from "../client/errors";
import { isUuid, resolveServer } from "../client/resolve";
import type { Me, Server } from "../client/types";
import { loadConfig } from "../config/store";
import { ManagerError } from "./manager";

export interface OrgView {
  id: string;
  slug: string;
  name: string;
}

export interface ServerView {
  id: string;
  name: string;
  slug: string;
  connection_type: string;
  status: string;
}

export interface PortView {
  port: number;
  protocol: string;
  bind_address: string;
  process: string;
}

export interface ResolvedServer {
  org: string;
  tenant_id: string;
  profile: string;
  server: string;
  server_id: string;
}

export interface Directory {
  /** True when a stored profile or an environment credential exists. No network. */
  signedIn(): Promise<boolean>;
  orgs(): Promise<OrgView[]>;
  servers(org: string): Promise<ServerView[]>;
  /** The port scan stored on the server record; empty when the server was never scanned. */
  ports(org: string, server: string, profile?: string): Promise<PortView[]>;
  resolve(input: { org: string; server: string; profile?: string }): Promise<ResolvedServer>;
}

export function translateUpstream(err: unknown): ManagerError {
  if (err instanceof ManagerError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  const exitCode = (err as { exitCode?: unknown } | null)?.exitCode;
  if (name === "ReauthRequiredError" || exitCode === 3) return new ManagerError("unauthorized", message, "needs_sign_in");
  if (exitCode === 4) return new ManagerError("invalid", message);
  if (exitCode === 5) return new ManagerError("not_found", message);
  if (err instanceof ApiError) {
    if (err.status === 401) return new ManagerError("unauthorized", message, "needs_sign_in");
    if (err.status === 403) return new ManagerError("forbidden", message, "forbidden");
    if (err.status === 404) return new ManagerError("not_found", message);
  }
  return new ManagerError("upstream", message);
}

interface ScanRecord {
  port_scan?: { listening_ports?: Array<{ port?: number; protocol?: string; address?: string; process?: string | null }> } | null;
}

export class ApiDirectory implements Directory {
  constructor(private readonly boot: (o: BootstrapOptions) => Promise<ResolvedContext> = bootstrap) {}

  async signedIn(): Promise<boolean> {
    if (isEnvCredential()) return true;
    const cfg = await loadConfig();
    const profile = cfg.active_profile ? cfg.profiles[cfg.active_profile] : undefined;
    return Boolean(profile && (profile.token || profile.token_ref));
  }

  async orgs(): Promise<OrgView[]> {
    return this.guard(async () => {
      const ctx = await this.boot({ orgRequired: false, ignoreProjectOrg: true });
      const me = await ctx.client.get<Me>("/auth/me");
      return (me.memberships ?? []).map((m) => ({ id: m.tenant_id, slug: m.tenant_slug, name: m.tenant_name }));
    });
  }

  async servers(org: string): Promise<ServerView[]> {
    return this.guard(async () => {
      const { ctx, tenantId } = await this.context(org);
      const servers = await ctx.client.get<Server[]>(`/tenants/${tenantId}/servers/`);
      return servers.map(serverView);
    });
  }

  async ports(org: string, server: string, profile?: string): Promise<PortView[]> {
    return this.guard(async () => {
      const { ctx, tenantId } = await this.context(org, profile);
      const serverId = await resolveServer(ctx.client, tenantId, server);
      const record = await ctx.client.get<ScanRecord>(`/tenants/${tenantId}/servers/${serverId}`);
      return (record.port_scan?.listening_ports ?? []).map((p) => ({
        port: Number(p.port),
        protocol: p.protocol ?? "tcp",
        bind_address: p.address ?? "",
        process: p.process ?? "",
      }));
    });
  }

  async resolve(input: { org: string; server: string; profile?: string }): Promise<ResolvedServer> {
    return this.guard(async () => {
      const { ctx, tenantId } = await this.context(input.org, input.profile);
      const serverId = await resolveServer(ctx.client, tenantId, input.server);
      let display = input.server;
      if (isUuid(input.server)) {
        const servers = await ctx.client.get<Server[]>(`/tenants/${tenantId}/servers/`);
        const found = servers.find((s) => s.id === input.server);
        display = found?.name ?? found?.slug ?? found?.hostname ?? input.server;
      }
      return { org: ctx.orgSlug ?? input.org, tenant_id: tenantId, profile: ctx.profileName, server: display, server_id: serverId };
    });
  }

  private async context(org: string, profile?: string): Promise<{ ctx: ResolvedContext; tenantId: string }> {
    const ctx = await this.boot({ org, ignoreProjectOrg: true, ...(profile === undefined ? {} : { profile }) });
    return { ctx, tenantId: await requireTenantId(ctx) };
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw translateUpstream(err);
    }
  }
}

function serverView(s: Server): ServerView {
  return {
    id: s.id,
    name: s.name ?? s.hostname,
    slug: s.slug,
    connection_type: s.connection_type,
    status: s.status,
  };
}
