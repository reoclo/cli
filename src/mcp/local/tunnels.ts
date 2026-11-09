// src/mcp/local/tunnels.ts
//
// Tunnel tools for the local `reoclo mcp` only. They talk to the tunnel daemon
// on this machine, so they live outside src/mcp/tools (which the hosted MCP
// vendors) and register from src/commands/mcp.ts.

import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveServer } from "../../client/resolve";
import type { Server } from "../../client/types";
import { buildAddBody, buildEditBody, type AddOptions, type EditOptions } from "../../commands/tunnel-saved";
import type { ApprovalView } from "../../tunnels/approvals";
import { DaemonError, type ClientIdentity, type ControlClient, type GatedReply } from "../../tunnels/control-client";
import type { TunnelView } from "../../tunnels/manager";
import { caCertFile } from "../../tunnels/paths";
import type { McpRegistrationContext } from "../tools/context";

export interface LocalTunnelDeps {
  ctx: McpRegistrationContext;
  /** The organization this server runs under; undefined for an environment credential. */
  org?: string;
  profile: string;
  /** A client for the tunnel daemon, started first when it is not running. */
  connect(identity: ClientIdentity): Promise<ControlClient>;
  /** Ends the wait for an approval. Default: 60 seconds. */
  waitSignal?: () => AbortSignal;
  /** Where the local CA certificate is, when one exists. */
  caPath?: () => string | undefined;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true };

function result(body: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], ...(isError ? { isError: true as const } : {}) };
}

function failure(err: unknown): ToolResult {
  if (err instanceof DaemonError) {
    const hint =
      err.code === "unreachable"
        ? "The tunnel daemon is not reachable. Ask the person to run: reoclo tunnel daemon start"
        : err.code === "unauthorized" || err.state === "needs_sign_in"
          ? "The sign-in expired. Ask the person to run: reoclo login"
          : err.code === "forbidden"
            ? "The server or organization refused the tunnel. Tell the person; an org admin may need to allow it."
            : undefined;
    return result({ error: err.message, code: err.code, ...(err.state ? { state: err.state } : {}), ...(hint ? { hint } : {}) }, true);
  }
  return result({ error: err instanceof Error ? err.message : String(err) }, true);
}

/** What an agent needs to know about a tunnel. */
export function shapeTunnel(t: TunnelView, caPath?: string): Record<string, unknown> {
  let endpoint: string | undefined;
  if (t.kind === "https") endpoint = t.url;
  else if (t.kind !== "reverse" && t.endpoint !== undefined) {
    endpoint = t.adhoc ? `${t.kind === "udp" ? "udp" : "http"}://${t.endpoint}` : t.endpoint;
  }
  return {
    name: t.name,
    kind: t.kind,
    state: t.state,
    message: t.message,
    ...(t.action !== "None" ? { action: t.action } : {}),
    ...(t.detail ? { detail: t.detail } : {}),
    org: t.org,
    server: t.server,
    ...(t.target ? { target: t.target } : {}),
    ...(t.kind === "reverse" ? { remote_port: t.remote_port, local_target: t.local_target } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(t.endpoint ? { address: t.endpoint } : {}),
    ...(t.hostname ? { hostname: t.hostname } : {}),
    via: t.via,
    path: t.path,
    ...(t.path_reason ? { path_reason: t.path_reason } : {}),
    ...(t.peer ? { tailnet_peer: t.peer } : {}),
    ...(t.share
      ? { share: { state: t.share.state, port: t.share.port, ...(t.share.url ? { url: t.share.url } : {}), ...(t.share.error ? { error: t.share.error } : {}) } }
      : {}),
    ad_hoc: t.adhoc === true,
    expires_at: t.expires_at ?? null,
    ...(caPath && t.kind === "https" ? { ca_path: caPath } : {}),
    traffic: t.traffic,
  };
}

function pendingMessage(a: ApprovalView): string {
  return (
    `A person has to approve this: ${a.description}. Tell them it is waiting, in the Reoclo desktop app or with: reoclo tunnel approve ${a.id} ` +
    `(or reoclo tunnel deny ${a.id}). It expires at ${a.expires_at}. Do not retry; ask again after they answer.`
  );
}

type Settled<T> = { done: true; value: T } | { done: false; result: ToolResult };

/** A reply is the finished action, or (202) an approval to wait on for up to the signal's limit. */
async function settle<T>(client: ControlClient, reply: GatedReply<T>, signal: AbortSignal): Promise<Settled<T>> {
  if (reply.status !== 202) return { done: true, value: reply.body as T };
  const approval = reply.body as ApprovalView;
  const decided = await client.waitForApproval(approval.id, signal);
  if (decided === undefined) {
    return {
      done: false,
      result: result({ status: "pending_approval", id: approval.id, action: approval.action, description: approval.description, message: pendingMessage(approval) }),
    };
  }
  if (decided.status === "approved") {
    if (decided.error) {
      return { done: false, result: result({ status: "approved_but_failed", error: decided.error.message, code: decided.error.code }, true) };
    }
    return { done: true, value: decided.result as T };
  }
  return {
    done: false,
    result: result({ status: decided.status, id: decided.id, message: `The person ${decided.status === "denied" ? "denied" : "did not answer"} this request: ${decided.description}. Do not retry unless they ask.` }, true),
  };
}

const ADD_FIELDS = {
  server: z.string().min(1).describe("Server name, slug or id"),
  kind: z.enum(["tcp", "udp", "https", "reverse"]).optional().describe("Default tcp, or https when hostname is given"),
  target: z.string().min(1).optional().describe("Forward tunnels: where the server connects, HOST:PORT or a bare port (127.0.0.1)"),
  local_port: z.number().int().min(1).max(65535).optional().describe("tcp or udp: local port to listen on"),
  hostname: z.string().min(1).optional().describe("Local hostname, such as grafana.prod-1.reoclo.localhost. Needs approval."),
  keep_up: z.boolean().optional().describe("Hold the gateway session open instead of opening it on demand"),
  via: z.enum(["reoclo", "tailscale", "auto"]).optional().describe("Transport: the Reoclo relay (default), the tailnet, or the tailnet with the relay as fallback"),
  tailnet_host: z.string().min(1).optional().describe("The server's name on the tailnet, when it differs from its Reoclo hostname"),
  remote_port: z.number().int().min(1).max(65535).optional().describe("reverse: port the server listens on. Needs approval."),
  local_target: z.string().min(1).optional().describe("reverse: where this machine connects, HOST:PORT or a bare port"),
  bind_public: z.boolean().optional().describe("reverse: bind 0.0.0.0 on the server. Needs approval."),
};

function str(v: number | undefined): string | undefined {
  return v === undefined ? undefined : String(v);
}

export function registerLocalTunnelTools(server: McpServer, deps: LocalTunnelDeps): void {
  const agent = (): string | undefined => server.server.getClientVersion()?.name;
  const client = (): Promise<ControlClient> => deps.connect({ client: "mcp", agent: agent() });
  const signal = (): AbortSignal => (deps.waitSignal ?? (() => AbortSignal.timeout(60_000)))();
  const caPath = (): string | undefined => (deps.caPath ? deps.caPath() : existsSync(caCertFile()) ? caCertFile() : undefined);
  const needOrg = (): string => {
    if (deps.org === undefined) {
      throw new Error("tunnels need an organization: start reoclo mcp with --org <slug>, set $REOCLO_ORG, or add a .reoclo file");
    }
    return deps.org;
  };

  server.tool(
    "list_local_tunnels",
    "List the tunnels on this machine: saved tunnels and the ad-hoc ones agents opened, with state, endpoint or URL, expiry, the transport path (relay or tailscale) and any tailnet share.",
    {},
    async () => {
      try {
        const c = await client();
        return result({ tunnels: (await c.tunnels()).map((t) => shapeTunnel(t, caPath())) });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.tool(
    "open_tunnel",
    "Open a tunnel from this machine to a service on a Reoclo server. Pass `name` for a saved tunnel, or `server` and `target` for an ad-hoc forward tunnel on a free loopback port that closes after ttl_minutes (default 60, at most 480). " +
      "Waits up to 30 seconds for the connection, then returns the endpoint, ca_path (HTTPS tunnels) and expires_at. Forward tunnels need no approval. " +
      "A saved reverse tunnel, or one bound publicly, needs a person's approval: the call waits up to 60 seconds and, if nobody answers, returns status pending_approval with an id. " +
      "Report that to the person, say what you are waiting for, and do not retry.",
    {
      name: z.string().min(1).optional().describe("A saved tunnel to bring up"),
      server: z.string().min(1).optional().describe("Ad-hoc: server name, slug or id"),
      target: z.string().min(1).optional().describe("Ad-hoc: where the server connects, HOST:PORT or a bare port (127.0.0.1)"),
      kind: z.enum(["tcp", "udp"]).optional().describe("Ad-hoc: default tcp"),
      ttl_minutes: z.number().int().min(1).max(480).optional().describe("Ad-hoc: minutes before it closes. Default 60."),
    },
    async ({ name, server: serverName, target, kind, ttl_minutes }) => {
      try {
        if (name !== undefined && (serverName !== undefined || target !== undefined)) {
          return result({ error: "pass either name, or server and target, not both" }, true);
        }
        const c = await client();
        if (name !== undefined) {
          const reply = await c.requestWithStatus<TunnelView>("POST", `/v1/tunnels/${encodeURIComponent(name)}/up`, { verify: true }, 45_000);
          const settled = await settle(c, reply, signal());
          return settled.done ? result(shapeTunnel(settled.value, caPath())) : settled.result;
        }
        if (serverName === undefined || target === undefined) {
          return result({ error: "pass name for a saved tunnel, or server and target for an ad-hoc one" }, true);
        }
        const view = await c.openAdHoc({
          server: serverName,
          org: needOrg(),
          profile: deps.profile,
          target,
          kind: kind ?? "tcp",
          ttl_minutes: ttl_minutes ?? 60,
        });
        return result(shapeTunnel(view, caPath()));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.tool(
    "close_tunnel",
    "Bring a saved tunnel down (it stays saved), or end an ad-hoc tunnel. Never needs approval.",
    { name: z.string().min(1).describe("Tunnel name from list_local_tunnels") },
    async ({ name }) => {
      try {
        const view = await (await client()).down(name);
        return result({ name, closed: true, ad_hoc: view.adhoc === true, state: view.state });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.tool(
    "tunnel_status",
    "One tunnel's state, the reason and suggested action when it is not working, and its traffic.",
    { name: z.string().min(1).describe("Tunnel name from list_local_tunnels") },
    async ({ name }) => {
      try {
        return result(shapeTunnel(await (await client()).tunnel(name), caPath()));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.tool(
    "save_tunnel",
    "Save a tunnel definition, or change a saved one of the same name, and bring it up. " +
      "Saving a reverse tunnel, one bound publicly, or one with a hostname (https tunnels always have one) needs a person's approval: " +
      "the call waits up to 60 seconds and, if nobody answers, returns status pending_approval with an id. Report that to the person and do not retry. " +
      "Plain tcp and udp tunnels save without approval.",
    {
      name: z.string().min(1).describe("Tunnel name: lowercase letters, digits and hyphens"),
      up: z.boolean().optional().describe("Bring the tunnel up after saving. Default true."),
      ...ADD_FIELDS,
    },
    async (args) => {
      try {
        const org = needOrg();
        const { tenantId, client: api } = await deps.ctx.resolveOrg();
        const serverId = await resolveServer(api, tenantId, args.server);
        const servers = await api.get<Server[]>(`/tenants/${tenantId}/servers/`);
        const found = servers.find((s) => s.id === serverId);
        const display = found?.name ?? found?.slug ?? args.server;
        const opts: AddOptions & EditOptions = {
          server: args.server,
          target: args.target,
          kind: args.kind,
          hostname: args.hostname,
          localPort: str(args.local_port),
          keepUp: args.keep_up,
          via: args.via,
          tailnetHost: args.tailnet_host,
          up: args.up,
          remotePort: str(args.remote_port),
          localTarget: args.local_target,
          bindPublic: args.bind_public,
        };
        const c = await client();
        const existing = await c.tunnel(args.name).catch((err: unknown) => {
          if (err instanceof DaemonError && err.status === 404) return undefined;
          throw err;
        });
        const reply: GatedReply<TunnelView> =
          existing === undefined
            ? await c.requestWithStatus<TunnelView>(
                "POST",
                "/v1/tunnels",
                buildAddBody(args.name, opts, {
                  org,
                  tenant_id: tenantId,
                  profile: deps.profile,
                  server: display,
                  server_id: serverId,
                  server_hostname: found?.hostname,
                  connection_type: found?.connection_type,
                }),
              )
            : await c.requestWithStatus<TunnelView>("PATCH", `/v1/tunnels/${encodeURIComponent(args.name)}`, {
                ...buildEditBody(existing.kind, opts),
                server: display,
                server_id: serverId,
              });
        const settled = await settle(c, reply, signal());
        return settled.done ? result(shapeTunnel(settled.value, caPath())) : settled.result;
      } catch (err) {
        return failure(err);
      }
    },
  );
}
