// src/commands/tunnel-saved.ts
//
// `reoclo tunnel status|add|edit|rm|up|down`: saved tunnels, kept by the tunnel daemon.

import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { isUuid, resolveServer } from "../client/resolve";
import type { Server } from "../client/types";
import { globalOutput, printList, printMutation, resolveFormat, type OutputFormat } from "../ui/output";
import { connectToDaemon, DaemonError } from "../tunnels/control-client";
import type { TunnelView } from "../tunnels/manager";

export interface AddOptions {
  server?: string;
  target?: string;
  kind?: string;
  localPort?: string;
  keepUp?: boolean;
  up?: boolean;
  remotePort?: string;
  localTarget?: string;
  bindPublic?: boolean;
}

export interface EditOptions {
  server?: string;
  target?: string;
  localPort?: string;
  keepUp?: boolean;
  remotePort?: string;
  localTarget?: string;
  bindPublic?: boolean;
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

const FORWARD_ONLY = ["target", "localPort"] as const;
const REVERSE_ONLY = ["remotePort", "localTarget", "bindPublic"] as const;
const FLAG_NAME: Record<string, string> = {
  target: "--target",
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
}

/** The body for POST /v1/tunnels. Throws UsageError for a flag mix that makes no sense. */
export function buildAddBody(name: string, opts: AddOptions, ctx: AddContext): Record<string, unknown> {
  const kind = opts.kind ?? "tcp";
  if (kind !== "tcp" && kind !== "udp" && kind !== "reverse") {
    throw new UsageError(`invalid --kind: ${JSON.stringify(kind)} (expected tcp, udp or reverse)`);
  }
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
  if (opts.localPort !== undefined) body["local_port"] = parsePortFlag("--local-port", opts.localPort);
  return body;
}

/** The body for PATCH /v1/tunnels/{name}: only what the user passed. */
export function buildEditBody(kind: string, opts: EditOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (kind === "reverse") rejectFlags(kind, opts, FORWARD_ONLY);
  else rejectFlags(kind, opts, REVERSE_ONLY);
  if (opts.target !== undefined) body["target"] = parseHostPortFlag("--target", opts.target);
  if (opts.localPort !== undefined) body["local_port"] = parsePortFlag("--local-port", opts.localPort);
  if (opts.remotePort !== undefined) body["remote_port"] = parsePortFlag("--remote-port", opts.remotePort);
  if (opts.localTarget !== undefined) body["local_target"] = parseHostPortFlag("--local-target", opts.localTarget);
  if (opts.bindPublic !== undefined) body["bind_public"] = opts.bindPublic;
  if (opts.keepUp !== undefined) body["keep_up"] = opts.keepUp;
  return body;
}

/** What the DETAIL column shows: the daemon's detail, else the suggested action when there is one. */
export function detailFor(t: TunnelView): string {
  if (t.detail) return t.detail;
  return t.action === "None" ? "" : t.action.replace("<name>", t.name);
}

function localOf(t: TunnelView): string {
  return t.kind === "reverse" ? (t.local_target ?? "") : (t.endpoint ?? "");
}

function targetOf(t: TunnelView): string {
  return t.kind === "reverse" ? `${t.server}:${t.remote_port ?? ""}` : `${t.server}:${t.target ?? ""}`;
}

export function formatSavedTunnels(items: TunnelView[], fmt: OutputFormat): void {
  if (fmt === "json") {
    for (const t of items) process.stdout.write(JSON.stringify(t) + "\n");
    return;
  }
  if (items.length === 0) {
    process.stdout.write("no saved tunnels; add one with: reoclo tunnel add <name> --server <server> --target <port>\n");
    return;
  }
  printList(
    items.map((t) => ({
      name: t.name,
      server: t.server,
      kind: t.kind,
      local: localOf(t),
      target: targetOf(t),
      state: t.state,
      detail: detailFor(t),
    })),
    [
      { key: "name", label: "NAME" },
      { key: "server", label: "SERVER" },
      { key: "kind", label: "KIND" },
      { key: "local", label: "LOCAL" },
      { key: "target", label: "TARGET" },
      { key: "state", label: "STATE" },
      { key: "detail", label: "DETAIL" },
    ],
    fmt,
  );
}

function summary(t: TunnelView): string {
  const where = t.kind === "reverse" ? `${t.server}:${t.remote_port} -> ${t.local_target}` : `${t.endpoint} -> ${t.server}:${t.target}`;
  return `tunnel: ${t.name} (${t.kind}) ${where}: ${t.state}`;
}

function fail(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`tunnel: ${msg}`);
  const code = (err as { exitCode?: unknown } | null)?.exitCode;
  process.exit(typeof code === "number" ? code : 1);
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
        formatSavedTunnels(items, fmt);
      } catch (err) {
        fail(err);
      }
    });

  tunnelCmd
    .command("add <name>")
    .description("save a tunnel; the tunnel daemon keeps it up across terminals and restarts")
    .requiredOption("--server <server>", "server name, slug or id")
    .option("--target <host:port|port>", "forward: where the server connects (a bare port means 127.0.0.1)")
    .option("--kind <kind>", "tcp, udp or reverse (default tcp)")
    .option("--local-port <port>", "forward: local port to listen on (default: the target port when free)")
    .option("--keep-up", "hold the gateway session open instead of opening it on demand")
    .option("--no-up", "save the tunnel without bringing it up")
    .option("--remote-port <port>", "reverse: port the server listens on")
    .option("--local-target <host:port|port>", "reverse: where this machine connects")
    .option("--bind-public", "reverse: bind 0.0.0.0 on the server")
    .addHelpText(
      "after",
      `
Examples:
  $ reoclo tunnel add prod-db --server prod-1 --target 5432
  $ reoclo tunnel add prod-db --server prod-1 --target db.internal:5432 --local-port 15432 --keep-up
  $ reoclo tunnel add hook --server prod-1 --kind reverse --remote-port 8080 --local-target 3000
`,
    )
    .action(async (name: string, opts: AddOptions) => {
      try {
        const ctx = await bootstrap();
        if (!ctx.orgSlug) {
          throw new UsageError("tunnel add needs an organization: pass --org <slug>, set $REOCLO_ORG, or add a .reoclo file");
        }
        const tenantId = await requireTenantId(ctx);
        const serverId = await resolveServer(ctx.client, tenantId, opts.server ?? "");
        const body = buildAddBody(name, opts, {
          org: ctx.orgSlug,
          tenant_id: tenantId,
          profile: ctx.profileName,
          server: await displayName(ctx, tenantId, opts.server ?? ""),
          server_id: serverId,
        });
        const client = await connectToDaemon();
        const saved = await client.add(body);
        printMutation(program, saved as unknown as Record<string, unknown>, summary(saved));
      } catch (err) {
        fail(err);
      }
    });

  tunnelCmd
    .command("edit <name>")
    .description("change a saved tunnel; it restarts when it is up")
    .option("--server <server>", "server name, slug or id")
    .option("--target <host:port|port>", "forward: where the server connects")
    .option("--local-port <port>", "forward: local port to listen on")
    .option("--keep-up", "hold the gateway session open")
    .option("--no-keep-up", "open the gateway session on demand")
    .option("--remote-port <port>", "reverse: port the server listens on")
    .option("--local-target <host:port|port>", "reverse: where this machine connects")
    .option("--bind-public", "reverse: bind 0.0.0.0 on the server")
    .option("--no-bind-public", "reverse: bind 127.0.0.1 on the server")
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
