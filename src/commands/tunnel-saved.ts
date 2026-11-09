// src/commands/tunnel-saved.ts
//
// `reoclo tunnel status|add|edit|rm|up|down`: saved tunnels, kept by the tunnel daemon.

import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { isUuid, resolveServer } from "../client/resolve";
import type { Server } from "../client/types";
import { globalOutput, printList, printMutation, resolveFormat, type OutputFormat } from "../ui/output";
import { VIA_VALUES, type Via } from "../tunnels/config";
import { connectToDaemon, DaemonError, type ControlClient, type DaemonStatus } from "../tunnels/control-client";
import { BASE_SUFFIX, isValidHostname } from "../tunnels/hosts-block";
import type { ForegroundTunnel } from "../tunnels/foreground";
import type { TunnelView } from "../tunnels/manager";
import { targetProblem } from "../tunnels/tailscale";

export interface AddOptions {
  server?: string;
  target?: string;
  kind?: string;
  hostname?: string;
  localPort?: string;
  keepUp?: boolean;
  up?: boolean;
  remotePort?: string;
  localTarget?: string;
  bindPublic?: boolean;
  via?: string;
  tailnetHost?: string;
}

export interface EditOptions {
  server?: string;
  target?: string;
  hostname?: string;
  localPort?: string;
  keepUp?: boolean;
  remotePort?: string;
  localTarget?: string;
  bindPublic?: boolean;
  via?: string;
  tailnetHost?: string;
}

/** A usage mistake: exit code 2. */
export class UsageError extends Error {
  exitCode = 2;
}

export function parsePortFlag(flag: string, value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new UsageError(`invalid ${flag}: ${JSON.stringify(value)} (expected a port from 1 to 65535)`);
  }
  return Number(value);
}

/** `5432` means 127.0.0.1:5432; `host:port` is kept. */
export function parseHostPortFlag(flag: string, value: string): string {
  if (/^\d+$/.test(value)) return `127.0.0.1:${parsePortFlag(flag, value)}`;
  const m = /^([^\s:]+):(\d+)$/.exec(value);
  if (!m) throw new UsageError(`invalid ${flag}: ${JSON.stringify(value)} (expected HOST:PORT or PORT)`);
  parsePortFlag(flag, m[2] ?? "");
  return value;
}

const FORWARD_ONLY = ["target", "localPort", "hostname"] as const;
const HTTPS_REJECTS = ["localPort"] as const;
const REVERSE_ONLY = ["remotePort", "localTarget", "bindPublic"] as const;
/** A local route has no server, gateway session or transport: only a hostname and a local target. */
const LOCAL_REJECTS = ["server", "target", "localPort", "remotePort", "bindPublic", "keepUp", "via", "tailnetHost"] as const;
const FLAG_NAME: Record<string, string> = {
  server: "--server",
  keepUp: "--keep-up",
  via: "--via",
  tailnetHost: "--tailnet-host",
  target: "--target",
  hostname: "--hostname",
  localPort: "--local-port",
  remotePort: "--remote-port",
  localTarget: "--local-target",
  bindPublic: "--bind-public",
};

function rejectFlags(kind: string, opts: object, names: readonly string[]): void {
  for (const n of names) {
    if ((opts as Record<string, unknown>)[n] !== undefined && (opts as Record<string, unknown>)[n] !== false) {
      throw new UsageError(`${FLAG_NAME[n]} does not apply to a ${kind} tunnel`);
    }
  }
}

export interface AddContext {
  org: string;
  tenant_id: string;
  profile: string;
  server: string;
  server_id: string;
  /** The server's own hostname, saved so the daemon can find it among tailnet peers. */
  server_hostname?: string;
  /** An SSH server has no runner, so its tunnels default to the tailnet. */
  connection_type?: string;
}

export function parseViaFlag(value: string): Via {
  if (!(VIA_VALUES as readonly string[]).includes(value)) {
    throw new UsageError(`invalid --via: ${JSON.stringify(value)} (expected reoclo, tailscale or auto)`);
  }
  return value as Via;
}

function parseTailnetHost(value: string): string {
  const host = value.trim();
  if (host === "") throw new UsageError("invalid --tailnet-host: it must not be empty");
  return host;
}

/** The transport fields of a new tunnel. A reverse tunnel can only use the relay. */
function transportFields(kind: string, opts: AddOptions, ctx: AddContext): Record<string, unknown> {
  const explicit = opts.via === undefined ? undefined : parseViaFlag(opts.via);
  if (kind === "reverse") {
    if (explicit !== undefined && explicit !== "reoclo") throw new UsageError("a reverse tunnel can only use the relay (--via reoclo)");
    if (opts.tailnetHost !== undefined) throw new UsageError("--tailnet-host does not apply to a reverse tunnel");
    return {};
  }
  const via = explicit ?? (ctx.connection_type === "ssh" ? "tailscale" : undefined);
  if (opts.tailnetHost !== undefined && (via === undefined || via === "reoclo")) {
    throw new UsageError("--tailnet-host needs --via tailscale or --via auto");
  }
  return {
    ...(via === undefined ? {} : { via }),
    ...(opts.tailnetHost === undefined ? {} : { tailnet_host: parseTailnetHost(opts.tailnetHost) }),
    ...(ctx.server_hostname === undefined ? {} : { server_hostname: ctx.server_hostname }),
  };
}

/** A DNS label from a server's display name: lowercase letters, digits and hyphens, at most 63 characters. */
export function slugLabel(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return slug === "" ? "server" : slug;
}

export function parseHostnameFlag(value: string): string {
  const host = value.trim().toLowerCase();
  if (!isValidHostname(host)) {
    throw new UsageError(`invalid --hostname: ${JSON.stringify(value)} (expected a DNS name such as grafana.prod-1.reoclo.localhost)`);
  }
  return host;
}

/** The kind `add` saves: --kind, else https when --hostname is given, else tcp. */
export function addKindOf(opts: Pick<AddOptions, "kind" | "hostname">): string {
  const kind = opts.kind ?? (opts.hostname !== undefined ? "https" : "tcp");
  if (kind !== "tcp" && kind !== "udp" && kind !== "https" && kind !== "reverse" && kind !== "local") {
    throw new UsageError(`invalid --kind: ${JSON.stringify(kind)} (expected tcp, udp, https, reverse or local)`);
  }
  return kind;
}

function buildLocalAddBody(name: string, opts: AddOptions): Record<string, unknown> {
  rejectFlags("local", opts, LOCAL_REJECTS);
  if (opts.hostname === undefined) throw new UsageError("a local tunnel needs --hostname");
  if (opts.localTarget === undefined) throw new UsageError("a local tunnel needs --local-target");
  return {
    name,
    kind: "local",
    hostname: parseHostnameFlag(opts.hostname),
    local_target: parseHostPortFlag("--local-target", opts.localTarget),
    enabled: opts.up !== false,
  };
}

/** The body for POST /v1/tunnels. Throws UsageError for a flag mix that makes no sense. A local route needs no `ctx`. */
export function buildAddBody(name: string, opts: AddOptions, ctx?: AddContext): Record<string, unknown> {
  const kind = addKindOf(opts);
  if (kind === "local") return buildLocalAddBody(name, opts);
  if (ctx === undefined) throw new UsageError(`a ${kind} tunnel needs --server`);
  const body: Record<string, unknown> = {
    name,
    org: ctx.org,
    tenant_id: ctx.tenant_id,
    profile: ctx.profile,
    server: ctx.server,
    server_id: ctx.server_id,
    kind,
    keep_up: opts.keepUp === true,
    enabled: opts.up !== false,
    ...transportFields(kind, opts, ctx),
  };
  if (kind === "reverse") {
    rejectFlags(kind, opts, FORWARD_ONLY);
    if (opts.remotePort === undefined) throw new UsageError("a reverse tunnel needs --remote-port");
    if (opts.localTarget === undefined) throw new UsageError("a reverse tunnel needs --local-target");
    body["remote_port"] = parsePortFlag("--remote-port", opts.remotePort);
    body["local_target"] = parseHostPortFlag("--local-target", opts.localTarget);
    body["bind_public"] = opts.bindPublic === true;
    return body;
  }
  rejectFlags(kind, opts, REVERSE_ONLY);
  if (opts.target === undefined) throw new UsageError(`a ${kind} tunnel needs --target`);
  body["target"] = parseHostPortFlag("--target", opts.target);
  if (kind === "https") {
    rejectFlags(kind, opts, HTTPS_REJECTS);
    body["hostname"] =
      opts.hostname !== undefined ? parseHostnameFlag(opts.hostname) : `${name}.${slugLabel(ctx.server)}.${BASE_SUFFIX}`;
    return body;
  }
  if (opts.localPort !== undefined) body["local_port"] = parsePortFlag("--local-port", opts.localPort);
  if (opts.hostname !== undefined) body["hostname"] = parseHostnameFlag(opts.hostname);
  return body;
}

/** The body for PATCH /v1/tunnels/{name}: only what the user passed. */
export function buildEditBody(kind: string, opts: EditOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (kind === "local") {
    rejectFlags(kind, opts, LOCAL_REJECTS);
    if (opts.hostname !== undefined) body["hostname"] = parseHostnameFlag(opts.hostname);
    if (opts.localTarget !== undefined) body["local_target"] = parseHostPortFlag("--local-target", opts.localTarget);
    return body;
  }
  if (kind === "reverse") rejectFlags(kind, opts, FORWARD_ONLY);
  else rejectFlags(kind, opts, REVERSE_ONLY);
  if (kind === "https") rejectFlags(kind, opts, HTTPS_REJECTS);
  if (opts.target !== undefined) body["target"] = parseHostPortFlag("--target", opts.target);
  if (opts.hostname !== undefined) body["hostname"] = parseHostnameFlag(opts.hostname);
  if (opts.localPort !== undefined) body["local_port"] = parsePortFlag("--local-port", opts.localPort);
  if (opts.remotePort !== undefined) body["remote_port"] = parsePortFlag("--remote-port", opts.remotePort);
  if (opts.localTarget !== undefined) body["local_target"] = parseHostPortFlag("--local-target", opts.localTarget);
  if (opts.bindPublic !== undefined) body["bind_public"] = opts.bindPublic;
  if (opts.keepUp !== undefined) body["keep_up"] = opts.keepUp;
  if (opts.via !== undefined) {
    const via = parseViaFlag(opts.via);
    if (kind === "reverse" && via !== "reoclo") throw new UsageError("a reverse tunnel can only use the relay (--via reoclo)");
    body["via"] = via;
  }
  if (opts.tailnetHost !== undefined) {
    if (kind === "reverse") throw new UsageError("--tailnet-host does not apply to a reverse tunnel");
    body["tailnet_host"] = parseTailnetHost(opts.tailnetHost);
  }
  return body;
}

/** What stops a `via: tailscale` or `auto` tunnel from using the tailnet, going by the server's port scan. A missing or failed scan is no problem. */
export async function tailnetWarnings(client: Pick<ControlClient, "ports">, body: Record<string, unknown>): Promise<string[]> {
  const kind = body["kind"];
  const target = body["target"];
  const via = body["via"];
  if ((kind !== "tcp" && kind !== "udp" && kind !== "https") || typeof target !== "string") return [];
  if (via !== "tailscale" && via !== "auto") return [];
  let ports: Awaited<ReturnType<ControlClient["ports"]>> | undefined;
  try {
    ports = await client.ports(String(body["org"]), String(body["server_id"]));
  } catch {
    ports = undefined;
  }
  const problem = targetProblem(kind, target, ports);
  if (problem === undefined) return [];
  return [`${problem}; ${via === "tailscale" ? "connections will be refused until that changes" : "this tunnel will use the relay"}`];
}

/** "in 9m", "in 1h 5m" or "expired": the time left until an ISO timestamp. */
export function formatExpiry(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now;
  if (!(ms > 0)) return "expired";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `in ${Math.max(1, Math.round(ms / 1000))}s`;
  if (minutes < 60) return `in ${minutes}m`;
  return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** What the DETAIL column shows: the daemon's detail, else the suggested action when there is one; ad-hoc tunnels add when they end, shares add why they are not up. */
export function detailFor(t: TunnelView, now = Date.now()): string {
  const base = t.detail ? t.detail : t.action === "None" ? "" : t.action.replace("<name>", t.name);
  const parts = [
    base,
    ...(t.path_reason ? [t.path_reason] : []),
    ...(t.share?.error ? [`share: ${t.share.error}`] : []),
    ...(t.adhoc && t.expires_at ? [`ends ${formatExpiry(t.expires_at, now)}`] : []),
  ];
  return parts.filter((s) => s !== "").join("; ");
}

/** The SHARED column: where the share answers, or why it is not up. */
export function sharedLabel(t: TunnelView): string {
  if (!t.share) return "";
  return t.share.state === "active" && t.share.url ? t.share.url : t.share.state;
}

function localOf(t: TunnelView): string {
  if (t.kind === "reverse") return t.local_target ?? "";
  return t.kind === "https" || t.kind === "local" ? (t.url ?? "") : (t.endpoint ?? "");
}

/** What to tell someone who just saved an HTTPS tunnel that cannot open yet. One line each. */
export function httpsHints(status: Pick<DaemonStatus, "ca" | "hosts">): string[] {
  const hints: string[] = [];
  if (!status.ca?.exists || !status.ca.trusted) {
    hints.push("the local CA is not trusted yet, so browsers will warn; run: reoclo tunnel trust");
  } else if (status.ca.stale) {
    hints.push("tunnels.yaml allows suffixes the local CA does not cover; run: reoclo tunnel trust");
  }
  if (status.hosts && !status.hosts.installed) {
    hints.push("Safari and other apps that use the system resolver need a hosts entry; run: reoclo hosts setup");
  }
  return hints;
}

function targetOf(t: TunnelView): string {
  if (t.kind === "local") return t.local_target ?? "";
  return t.kind === "reverse" ? `${t.server}:${t.remote_port ?? ""}` : `${t.server}:${t.target ?? ""}`;
}

export function formatForegroundTunnels(items: ForegroundTunnel[]): void {
  if (items.length === 0) return;
  process.stdout.write("Running in a terminal:\n");
  printList(
    items.map((t) => ({
      server: t.server,
      org: t.org,
      state: t.state,
      forwards: t.forwards.map((f) => `${f.listen} -> ${f.target}`).join(", "),
      pid: String(t.pid),
    })),
    [
      { key: "server", label: "SERVER" },
      { key: "org", label: "ORG" },
      { key: "state", label: "STATE" },
      { key: "forwards", label: "FORWARDS" },
      { key: "pid", label: "PID" },
    ],
    "text",
  );
}

export function formatSavedTunnels(items: TunnelView[], fmt: OutputFormat, terminal: ForegroundTunnel[] = []): void {
  if (fmt === "json") {
    for (const t of items) process.stdout.write(JSON.stringify(t) + "\n");
    return;
  }
  if (items.length === 0 && terminal.length > 0) return;
  if (items.length === 0) {
    process.stdout.write("no saved tunnels; add one with: reoclo tunnel add <name> --server <server> --target <port>\n");
    return;
  }
  printList(
    items.map((t) => ({
      name: t.name,
      server: t.kind === "local" ? "local" : t.server,
      kind: t.adhoc ? `${t.kind} (ad-hoc)` : t.kind,
      local: localOf(t),
      target: targetOf(t),
      state: t.state,
      path: t.path,
      shared: sharedLabel(t),
      detail: detailFor(t),
    })),
    [
      { key: "name", label: "NAME" },
      { key: "server", label: "SERVER" },
      { key: "kind", label: "KIND" },
      { key: "local", label: "LOCAL" },
      { key: "target", label: "TARGET" },
      { key: "state", label: "STATE" },
      { key: "path", label: "PATH" },
      { key: "shared", label: "SHARED" },
      { key: "detail", label: "DETAIL" },
    ],
    fmt,
  );
}

function summary(t: TunnelView): string {
  if (t.kind === "local") return `tunnel: ${t.name} (local) ${t.url} -> ${t.local_target}: ${t.state}`;
  const from = t.kind === "https" ? t.url : t.endpoint;
  const where = t.kind === "reverse" ? `${t.server}:${t.remote_port} -> ${t.local_target}` : `${from} -> ${t.server}:${t.target}`;
  return `tunnel: ${t.name} (${t.kind}) ${where}: ${t.state}`;
}

function shareSummary(t: TunnelView): string {
  const s = t.share;
  if (!s) return `tunnel: ${t.name} is not shared`;
  if (s.state === "down") return `tunnel: ${t.name} is shared on port ${s.port}; the share starts when the tunnel is up`;
  return `tunnel: ${t.name} shared on the tailnet: ${s.url ?? `port ${s.port}`} (${s.state})`;
}

/** Wait until the share is up or says why it is not, so the command can print where it answers. */
async function waitForShare(client: ControlClient, name: string, timeoutMs = 10_000): Promise<TunnelView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const t = await client.tunnel(name);
    const state = t.share?.state;
    if (state === undefined || state === "active" || state === "down" || t.share?.error || Date.now() >= deadline) return t;
    await new Promise((r) => setTimeout(r, 200));
  }
}

function fail(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`tunnel: ${msg}`);
  const code = (err as { exitCode?: unknown } | null)?.exitCode;
  process.exit(typeof code === "number" ? code : 1);
}

interface ServerInfo {
  display: string;
  hostname?: string;
  connection_type?: string;
}

async function serverInfo(ctx: Awaited<ReturnType<typeof bootstrap>>, tenantId: string, identifier: string, serverId: string): Promise<ServerInfo> {
  try {
    const servers = await ctx.client.get<Server[]>(`/tenants/${tenantId}/servers/`);
    const s = servers.find((x) => x.id === serverId);
    if (s) {
      return {
        display: isUuid(identifier) ? (s.name ?? s.slug ?? s.hostname ?? identifier) : identifier,
        hostname: s.hostname,
        connection_type: s.connection_type,
      };
    }
  } catch {
    return { display: identifier };
  }
  return { display: identifier };
}

async function displayName(ctx: Awaited<ReturnType<typeof bootstrap>>, tenantId: string, identifier: string): Promise<string> {
  if (!isUuid(identifier)) return identifier;
  try {
    const servers = await ctx.client.get<Server[]>(`/tenants/${tenantId}/servers/`);
    const s = servers.find((x) => x.id === identifier);
    return s?.name ?? s?.slug ?? s?.hostname ?? identifier;
  } catch {
    return identifier;
  }
}

export function registerTunnelSaved(tunnelCmd: Command, program: Command): void {
  tunnelCmd
    .command("status [name]")
    .description("show saved tunnels and their state")
    .action(async (name: string | undefined) => {
      const fmt = resolveFormat(globalOutput(program));
      try {
        const client = await connectToDaemon();
        const items = name ? [await client.tunnel(name)] : await client.tunnels();
        const terminal = name || fmt !== "text" ? [] : await client.foreground();
        formatSavedTunnels(items, fmt, terminal);
        if (items.length > 0 && terminal.length > 0) process.stdout.write("\n");
        formatForegroundTunnels(terminal);
      } catch (err) {
        fail(err);
      }
    });

  tunnelCmd
    .command("add <name>")
    .description("save a tunnel; the tunnel daemon keeps it up across terminals and restarts")
    .option("--server <server>", "server name, slug or id (required except for --kind local)")
    .option("--target <host:port|port>", "forward: where the server connects (a bare port means 127.0.0.1)")
    .option("--kind <kind>", "tcp, udp, https, reverse or local (default tcp, or https when --hostname is given)")
    .option("--hostname <name>", "local hostname; https defaults to <name>.<server>.reoclo.localhost; required for local")
    .option("--local-port <port>", "forward: local port to listen on (default: the target port when free)")
    .option("--keep-up", "hold the gateway session open instead of opening it on demand")
    .option("--no-up", "save the tunnel without bringing it up")
    .option("--remote-port <port>", "reverse: port the server listens on")
    .option("--local-target <host:port|port>", "reverse, local: where this machine connects")
    .option("--bind-public", "reverse: bind 0.0.0.0 on the server")
    .option("--via <transport>", "reoclo, tailscale or auto (default reoclo; tailscale for an SSH server)")
    .option("--tailnet-host <name>", "the server's name on the tailnet, when it differs from its Reoclo hostname")
    .addHelpText(
      "after",
      `
Examples:
  $ reoclo tunnel add prod-db --server prod-1 --target 5432 --via tailscale
  $ reoclo tunnel add prod-db --server prod-1 --target db.internal:5432 --local-port 15432 --keep-up
  $ reoclo tunnel add hook --server prod-1 --kind reverse --remote-port 8080 --local-target 3000
  $ reoclo tunnel add grafana --server prod-1 --kind https --target 3000
  $ reoclo tunnel add dev-app --kind local --hostname app.reoclo.test --local-target 127.0.0.1:48080
`,
    )
    .action(async (name: string, opts: AddOptions) => {
      try {
        const kind = addKindOf(opts);
        let addCtx: AddContext | undefined;
        if (kind !== "local") {
          if (opts.server === undefined) throw new UsageError(`a ${kind} tunnel needs --server`);
          const ctx = await bootstrap();
          if (!ctx.orgSlug) {
            throw new UsageError("tunnel add needs an organization: pass --org <slug>, set $REOCLO_ORG, or add a .reoclo file");
          }
          const tenantId = await requireTenantId(ctx);
          const serverId = await resolveServer(ctx.client, tenantId, opts.server);
          const info = await serverInfo(ctx, tenantId, opts.server, serverId);
          addCtx = {
            org: ctx.orgSlug,
            tenant_id: tenantId,
            profile: ctx.profileName,
            server: info.display,
            server_id: serverId,
            server_hostname: info.hostname,
            connection_type: info.connection_type,
          };
        }
        const body = buildAddBody(name, opts, addCtx);
        const client = await connectToDaemon();
        for (const warning of await tailnetWarnings(client, body)) console.error(`tunnel: warning: ${warning}`);
        const saved = await client.add(body);
        printMutation(program, saved as unknown as Record<string, unknown>, summary(saved));
        if (saved.kind === "https" && resolveFormat(globalOutput(program)) === "text") {
          for (const line of httpsHints(await client.status())) console.error(`tunnel: ${line}`);
        }
      } catch (err) {
        fail(err);
      }
    });

  tunnelCmd
    .command("edit <name>")
    .description("change a saved tunnel; it restarts when it is up")
    .option("--server <server>", "server name, slug or id")
    .option("--target <host:port|port>", "forward: where the server connects")
    .option("--hostname <name>", "local hostname for a tcp, udp, https or local tunnel")
    .option("--local-port <port>", "tcp, udp: local port to listen on")
    .option("--keep-up", "hold the gateway session open")
    .option("--no-keep-up", "open the gateway session on demand")
    .option("--remote-port <port>", "reverse: port the server listens on")
    .option("--local-target <host:port|port>", "reverse, local: where this machine connects")
    .option("--bind-public", "reverse: bind 0.0.0.0 on the server")
    .option("--no-bind-public", "reverse: bind 127.0.0.1 on the server")
    .option("--via <transport>", "reoclo, tailscale or auto")
    .option("--tailnet-host <name>", "the server's name on the tailnet")
    .action(async (name: string, opts: EditOptions) => {
      try {
        const client = await connectToDaemon();
        const current = await client.tunnel(name);
        const body = buildEditBody(current.kind, opts);
        if (opts.server !== undefined) {
          const ctx = await bootstrap({ org: current.org });
          const tenantId = await requireTenantId(ctx);
          body["server_id"] = await resolveServer(ctx.client, tenantId, opts.server);
          body["server"] = await displayName(ctx, tenantId, opts.server);
        }
        if (Object.keys(body).length === 0) throw new UsageError("nothing to change; pass at least one option");
        const saved = await client.edit(name, body);
        printMutation(program, saved as unknown as Record<string, unknown>, summary(saved));
      } catch (err) {
        fail(err);
      }
    });

  tunnelCmd
    .command("share <name>")
    .description("share a tcp or https tunnel with other devices on your tailnet; it ends with the tunnel")
    .option("--tailnet", "share on the tailnet, the only place a tunnel can be shared")
    .option("--port <port>", "the port tailnet devices connect to (default: 443 for https, the target port for tcp)")
    .action(async (name: string, opts: { tailnet?: boolean; port?: string }) => {
      try {
        if (opts.tailnet !== true) throw new UsageError("pass --tailnet; a tailnet is the only place a tunnel can be shared");
        const body: { tailnet: true; port?: number } = { tailnet: true };
        if (opts.port !== undefined) body.port = parsePortFlag("--port", opts.port);
        const client = await connectToDaemon();
        await client.share(name, body);
        const shared = await waitForShare(client, name);
        printMutation(program, shared as unknown as Record<string, unknown>, shareSummary(shared));
        if (shared.share?.error) {
          console.error(`tunnel: the share is saved but not up: ${shared.share.error}`);
          process.exit(1);
        }
      } catch (err) {
        fail(err);
      }
    });

  tunnelCmd
    .command("unshare <name>")
    .description("stop sharing a tunnel on the tailnet")
    .action(async (name: string) => {
      try {
        const client = await connectToDaemon();
        const t = await client.unshare(name);
        printMutation(program, t as unknown as Record<string, unknown>, `tunnel: ${name} is no longer shared`);
      } catch (err) {
        fail(err);
      }
    });

  tunnelCmd
    .command("rm <name...>")
    .description("bring saved tunnels down and remove them")
    .action(async (names: string[]) => {
      let failed = false;
      try {
        const client = await connectToDaemon();
        for (const name of names) {
          try {
            await client.remove(name);
            printMutation(program, { name, removed: true }, `tunnel: removed ${name}`);
          } catch (err) {
            failed = true;
            console.error(`tunnel: ${err instanceof DaemonError ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        fail(err);
      }
      if (failed) process.exit(1);
    });

  for (const verb of ["up", "down"] as const) {
    tunnelCmd
      .command(`${verb} <name...>`)
      .description(
        verb === "up"
          ? "bring saved tunnels up; the daemon restores them after a restart"
          : "bring saved tunnels down; they stay saved",
      )
      .action(async (names: string[]) => {
        let failed = false;
        try {
          const client = await connectToDaemon();
          for (const name of names) {
            try {
              const t = verb === "up" ? await client.up(name) : await client.down(name);
              printMutation(program, t as unknown as Record<string, unknown>, summary(t));
            } catch (err) {
              failed = true;
              console.error(`tunnel: ${err instanceof DaemonError ? err.message : String(err)}`);
            }
          }
        } catch (err) {
          fail(err);
        }
        if (failed) process.exit(1);
      });
  }
}
