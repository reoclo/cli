// src/commands/tunnel.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveServer } from "../client/resolve";
import { TunnelSession, type ForwardSpec, type ReverseSpec } from "../client/tunnel-session";
import { printList, printObject, resolveFormat } from "../ui/output";
import type { OutputFormat } from "../ui/output";

// ── Tunnel session types (from Task 8.1 API) ──────────────────────────────────

export interface TunnelInterruption {
  at: string;
  reason: string;
  recovered_at: string | null;
}

export interface TunnelSessionRead {
  id: string;
  tenant_id: string;
  server_id: string;
  user_id: string;
  tunnel_id: string;
  mode: "forward" | "reverse";
  proto: "tcp" | "udp";
  local_port: number;
  remote_host: string;
  remote_port: number;
  bind: string;
  reason: string | null;
  opened_at: string;
  closed_at: string | null;
  close_reason: string | null;
  bytes_in: number;
  bytes_out: number;
  datagrams_in: number;
  datagrams_out: number;
  peer_count: number;
  interruptions: TunnelInterruption[];
}

export interface TunnelCloseResponse {
  requested: boolean;
  gateway_found: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function globalOutput(program: Command): string | undefined {
  const opts: Record<string, unknown> = program.opts();
  return typeof opts["output"] === "string" ? opts["output"] : undefined;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function tunnelStatus(t: TunnelSessionRead): string {
  if (t.closed_at === null) return "active";
  return t.close_reason ? `closed (${t.close_reason})` : "closed";
}

function tunnelPorts(t: TunnelSessionRead): string {
  return `:${t.local_port}→${t.remote_host}:${t.remote_port}`;
}

export function formatTunnelTable(items: TunnelSessionRead[], fmt: OutputFormat): void {
  if (fmt === "json") {
    for (const item of items) process.stdout.write(JSON.stringify(item) + "\n");
    return;
  }
  if (items.length === 0) {
    process.stdout.write("no tunnels found\n");
    return;
  }
  printList(
    items.map((t) => ({
      id: t.id,
      server: t.server_id,
      mode: t.mode,
      proto: t.proto,
      ports: tunnelPorts(t),
      opened: t.opened_at,
      status: tunnelStatus(t),
      bytes: `${formatBytes(t.bytes_in)}/${formatBytes(t.bytes_out)}`,
    })),
    [
      { key: "id", label: "TUNNEL ID" },
      { key: "server", label: "SERVER" },
      { key: "mode", label: "MODE" },
      { key: "proto", label: "PROTO" },
      { key: "ports", label: "PORTS" },
      { key: "opened", label: "OPENED" },
      { key: "status", label: "STATUS" },
      { key: "bytes", label: "BYTES IN/OUT" },
    ],
    fmt,
  );
}

export function formatTunnelDescribe(t: TunnelSessionRead, fmt: OutputFormat): void {
  if (fmt === "json") {
    process.stdout.write(JSON.stringify(t, null, 2) + "\n");
    return;
  }
  // text: print top-level fields then interruptions sub-list
  const flat: Record<string, unknown> = {
    id: t.id,
    tenant_id: t.tenant_id,
    server_id: t.server_id,
    user_id: t.user_id,
    tunnel_id: t.tunnel_id,
    mode: t.mode,
    proto: t.proto,
    local_port: t.local_port,
    remote_host: t.remote_host,
    remote_port: t.remote_port,
    bind: t.bind,
    reason: t.reason ?? "",
    opened_at: t.opened_at,
    closed_at: t.closed_at ?? "",
    close_reason: t.close_reason ?? "",
    bytes_in: t.bytes_in,
    bytes_out: t.bytes_out,
    datagrams_in: t.datagrams_in,
    datagrams_out: t.datagrams_out,
    peer_count: t.peer_count,
  };
  printObject(flat, fmt);
  if (t.interruptions.length > 0) {
    process.stdout.write(`\ninterruptions (${t.interruptions.length}):\n`);
    for (const intr of t.interruptions) {
      const recovered = intr.recovered_at ? ` recovered_at=${intr.recovered_at}` : " (not recovered)";
      process.stdout.write(`  at=${intr.at}  reason=${intr.reason}${recovered}\n`);
    }
  } else {
    process.stdout.write("\ninterruptions: none\n");
  }
}

export interface ParsedTunnelArgs {
  server: string;
  forwards: ForwardSpec[];
  reverses: ReverseSpec[];
  reconnectDeadlineMs: number;
}

function parseDecimalInt(s: string, flag: "-L" | "-R", name: string): number {
  if (!/^\d+$/.test(s)) {
    throw new Error(`invalid ${flag} ${name}: ${JSON.stringify(s)} (expected non-negative decimal integer)`);
  }
  return Number(s);
}

function parseForwardSpec(spec: string, proto: "tcp" | "udp" = "tcp"): ForwardSpec {
  // Forms:
  //   local_port:remote_port                       (2 parts)
  //   local_port:remote_host:remote_port           (3 parts)
  //   bind:local_port:remote_host:remote_port      (4 parts)
  const parts = spec.split(":");
  let bind = "127.0.0.1";
  let localPort: number;
  let remoteHost: string;
  let remotePort: number;
  if (parts.length === 2) {
    localPort = parseDecimalInt(parts[0]!, "-L", "local_port");
    remoteHost = "127.0.0.1";
    remotePort = parseDecimalInt(parts[1]!, "-L", "remote_port");
  } else if (parts.length === 3) {
    localPort = parseDecimalInt(parts[0]!, "-L", "local_port");
    remoteHost = parts[1]!;
    remotePort = parseDecimalInt(parts[2]!, "-L", "remote_port");
  } else if (parts.length === 4) {
    bind = parts[0]!;
    localPort = parseDecimalInt(parts[1]!, "-L", "local_port");
    remoteHost = parts[2]!;
    remotePort = parseDecimalInt(parts[3]!, "-L", "remote_port");
  } else {
    throw new Error(`invalid -L spec: ${spec}`);
  }
  if (bind !== "127.0.0.1" && bind !== "0.0.0.0") {
    throw new Error(`invalid -L bind: ${bind} (only 127.0.0.1 or 0.0.0.0 supported)`);
  }
  if (localPort < 0 || localPort > 65535) {
    throw new Error(`invalid -L local_port: ${parts[parts.length === 4 ? 1 : 0]}`);
  }
  if (remotePort < 1 || remotePort > 65535) {
    throw new Error(`invalid -L remote_port: ${parts[parts.length - 1]}`);
  }
  return { localBind: bind, localPort, remoteHost, remotePort, proto };
}

function parseReverseSpec(spec: string, proto: "tcp" | "udp" = "tcp", bindPublicAllowed: boolean = false): ReverseSpec {
  // Forms:
  //   remote_port:local_port                            (2 parts; local_host=127.0.0.1)
  //   remote_port:local_host:local_port                 (3 parts)
  //   bind:remote_port:local_host:local_port            (4 parts)
  const parts = spec.split(":");
  let bind: "127.0.0.1" | "0.0.0.0" = "127.0.0.1";
  let remotePort: number;
  let localHost: string;
  let localPort: number;
  if (parts.length === 2) {
    remotePort = parseDecimalInt(parts[0]!, "-R", "remote_port");
    localHost = "127.0.0.1";
    localPort = parseDecimalInt(parts[1]!, "-R", "local_port");
  } else if (parts.length === 3) {
    remotePort = parseDecimalInt(parts[0]!, "-R", "remote_port");
    localHost = parts[1]!;
    localPort = parseDecimalInt(parts[2]!, "-R", "local_port");
  } else if (parts.length === 4) {
    if (parts[0] !== "127.0.0.1" && parts[0] !== "0.0.0.0") {
      throw new Error(`invalid -R bind: ${parts[0]} (only 127.0.0.1 or 0.0.0.0 supported)`);
    }
    bind = parts[0] as "127.0.0.1" | "0.0.0.0";
    remotePort = parseDecimalInt(parts[1]!, "-R", "remote_port");
    localHost = parts[2]!;
    localPort = parseDecimalInt(parts[3]!, "-R", "local_port");
  } else {
    throw new Error(`invalid -R spec: ${spec}`);
  }
  if (bind === "0.0.0.0" && !bindPublicAllowed) {
    throw new Error(`invalid -R bind: 0.0.0.0 requires --bind-public flag`);
  }
  if (remotePort < 1 || remotePort > 65535) {
    throw new Error(`invalid -R remote_port: ${remotePort}`);
  }
  if (localPort < 1 || localPort > 65535) {
    throw new Error(`invalid -R local_port: ${localPort}`);
  }
  return { remoteBind: bind, remotePort, localHost, localPort, proto };
}

export interface ParseOptions {
  L?: string[];
  R?: string[];
  udp?: boolean;
  bindPublic?: boolean;
  reconnectDeadline?: string;
}

export function parseTunnelArgs(server: string, opts: ParseOptions): ParsedTunnelArgs {
  const proto: "tcp" | "udp" = opts.udp ? "udp" : "tcp";
  const bindPublicAllowed = !!opts.bindPublic;
  const forwards = (opts.L ?? []).map((spec) => parseForwardSpec(spec, proto));
  const reverses = (opts.R ?? []).map((spec) => parseReverseSpec(spec, proto, bindPublicAllowed));
  if (forwards.length === 0 && reverses.length === 0) {
    throw new Error("at least one -L or -R spec is required");
  }
  const deadlineSec = opts.reconnectDeadline ? Number(opts.reconnectDeadline) : 300;
  if (!Number.isFinite(deadlineSec) || deadlineSec < 0) {
    throw new Error(`invalid --reconnect-deadline: ${opts.reconnectDeadline}`);
  }
  return { server, forwards, reverses, reconnectDeadlineMs: deadlineSec * 1000 };
}

/** Build wss://direct.reoclo.com/v1/tunnel?server_id=X from a directUrl + serverId. */
export function buildTunnelWsUrl(directUrl: string, serverId: string): string {
  const trimmed = directUrl.replace(/\/$/, "");
  const wsBase = trimmed.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return `${wsBase}/v1/tunnel?server_id=${encodeURIComponent(serverId)}`;
}

export function registerTunnel(program: Command): void {
  const tunnelCmd = program
    .command("tunnel [serverIdOrName]")
    .description(
      "open a TCP/UDP tunnel through a Reoclo runner (forward -L or reverse -R), or manage existing sessions",
    )
    .option(
      "-L <spec>",
      "forward [bind:]local_port:remote_host:remote_port (repeat for multiple)",
      (value, prev: string[] = []) => [...prev, value],
      [] as string[],
    )
    .option(
      "-R <spec>",
      "reverse [bind:]remote_port:local_host:local_port (repeat for multiple; bind=0.0.0.0 requires --bind-public)",
      (value, prev: string[] = []) => [...prev, value],
      [] as string[],
    )
    .option(
      "--udp",
      "use UDP for all forwards in this invocation (default: TCP)",
      false,
    )
    .option(
      "--bind-public",
      "allow -R specs to bind 0.0.0.0 on the server (default: 127.0.0.1 only)",
      false,
    )
    .option(
      "--reconnect-deadline <seconds>",
      "give up reconnecting after N seconds (default 300)",
      "300",
    )
    .action(async (idOrName: string | undefined, rawOpts: ParseOptions) => {
      if (!idOrName) {
        console.error("tunnel: specify a server ID or name, or use 'tunnel ls' to list sessions");
        process.exit(2);
      }

      let parsed: ParsedTunnelArgs;
      try {
        parsed = parseTunnelArgs(idOrName, rawOpts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`tunnel: ${msg}`);
        process.exit(2);
      }

      try {
        const ctx = await bootstrap();
        const tenantId = requireTenantId(ctx);
        const serverId = await resolveServer(ctx.client, tenantId, parsed.server);

        // direct.reoclo.com bypass URL — CF-bypass host for tunnel traffic.
        // No dedicated directUrl field exists on the context yet; derive from
        // streamsUrl by replacing the "streams." subdomain with "direct.".
        const directUrl =
          process.env["REOCLO_DIRECT_URL"]
          ?? deriveDirectUrl(ctx.streamsUrl);

        const gatewayUrl = buildTunnelWsUrl(directUrl, serverId);
        const session = new TunnelSession({
          gatewayUrl,
          token: ctx.token,
          forwards: parsed.forwards,
          reverses: parsed.reverses,
          reconnectDeadlineMs: parsed.reconnectDeadlineMs,
          onStatus: (s) => {
            if (s === "active") process.stderr.write("tunnel: connected\n");
            else if (s === "reconnecting") process.stderr.write("tunnel: reconnecting...\n");
            else if (s === "closed") process.stderr.write("tunnel: closed\n");
          },
        });

        // Register SIGINT BEFORE start() to catch Ctrl-C during initial connect
        let stopping = false;
        const onSigInt = async () => {
          if (stopping) return;
          stopping = true;
          await session.stop();
          process.exit(0);
        };
        process.on("SIGINT", onSigInt);

        const ready = await session.start();
        for (let i = 0; i < parsed.forwards.length; i++) {
          const f = parsed.forwards[i]!;
          const bound = ready.forwards[i];
          if (!bound) {
            console.error(`tunnel: internal error — TunnelSession returned ${ready.forwards.length} ready forwards but ${parsed.forwards.length} were requested`);
            await session.stop();
            process.exit(1);
          }
          console.log(
            `-L  ${f.localBind}:${bound.boundPort}  →  ${parsed.server}:${f.remoteHost}:${f.remotePort}  (${f.proto})`,
          );
        }
        for (let i = 0; i < parsed.reverses.length; i++) {
          const r = parsed.reverses[i]!;
          const bound = ready.reverses?.[i];
          if (!bound) {
            console.error(`tunnel: internal error — TunnelSession returned ${ready.reverses?.length ?? 0} ready reverses but ${parsed.reverses.length} were requested`);
            await session.stop();
            process.exit(1);
          }
          console.log(
            `-R  ${parsed.server}:${bound.boundPort}  →  ${r.localHost}:${r.localPort}  (${r.proto})`,
          );
        }
        console.log("Ctrl-C to close");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`tunnel: ${msg}`);
        process.exit(1);
      }
    });

  // ── tunnel ls ──────────────────────────────────────────────────────────────
  tunnelCmd
    .command("ls")
    .description("list tunnel sessions in the organization")
    .option("--server <slug>", "filter by server slug or ID")
    .option("--active", "show only active (open) sessions", false)
    .action(async (opts: { server?: string; active?: boolean }) => {
      const fmt = resolveFormat(globalOutput(program));
      try {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);

        const params = new URLSearchParams();
        if (opts.server) {
          const serverId = await resolveServer(ctx.client, tid, opts.server);
          params.set("server_id", serverId);
        }
        if (opts.active) {
          params.set("active", "true");
        }

        const qs = params.toString();
        const path = `/tenants/${tid}/tunnels${qs ? `?${qs}` : ""}`;
        const list = await ctx.client.get<TunnelSessionRead[]>(path);
        formatTunnelTable(list, fmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`tunnel: ${msg}`);
        process.exit(1);
      }
    });

  // ── tunnel describe <tunnel_id> ────────────────────────────────────────────
  tunnelCmd
    .command("describe <tunnelId>")
    .description("show full details for a tunnel session")
    .action(async (tunnelId: string) => {
      const fmt = resolveFormat(globalOutput(program));
      try {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const session = await ctx.client.get<TunnelSessionRead>(`/tenants/${tid}/tunnels/${tunnelId}`);
        formatTunnelDescribe(session, fmt);
      } catch (err) {
        if (err instanceof Error && err.name === "NotFoundError") {
          console.error(`tunnel: no session "${tunnelId}" found in your organization`);
          process.exit(1);
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`tunnel: ${msg}`);
        process.exit(1);
      }
    });

  // ── tunnel close <tunnel_id> ───────────────────────────────────────────────
  tunnelCmd
    .command("close <tunnelId>")
    .description("request graceful close of a live tunnel session")
    .action(async (tunnelId: string) => {
      try {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);

        let result: TunnelCloseResponse;
        try {
          result = await ctx.client.post<TunnelCloseResponse>(`/tenants/${tid}/tunnels/${tunnelId}/close`);
        } catch (err) {
          if (err instanceof Error) {
            if (err.name === "NotFoundError") {
              console.error(`tunnel: no session "${tunnelId}" found in your organization`);
              process.exit(1);
            }
            // 409 Conflict — session already closed
            if ("status" in err && (err as { status: number }).status === 409) {
              console.error(`tunnel: ${tunnelId} is already closed`);
              process.exit(1);
            }
          }
          throw err;
        }

        process.stdout.write(`tunnel: close requested for ${tunnelId}\n`);
        if (!result.gateway_found) {
          process.stdout.write(
            "tunnel: note — gateway-ws had no live tunnel for this session; the audit record may be stale\n",
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`tunnel: ${msg}`);
        process.exit(1);
      }
    });
}

function deriveDirectUrl(streamsUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(streamsUrl);
  } catch {
    // Not a valid URL — return as-is; the WebSocket dial will fail clearly.
    process.stderr.write(`tunnel: warning — could not parse streams URL ${streamsUrl}; set REOCLO_DIRECT_URL explicitly\n`);
    return streamsUrl;
  }
  const newHost = parsed.hostname.replace(/^streams\./, "direct.");
  if (newHost === parsed.hostname) {
    process.stderr.write(`tunnel: warning — could not derive direct URL from ${streamsUrl}; set REOCLO_DIRECT_URL explicitly\n`);
    return streamsUrl;
  }
  parsed.hostname = newHost;
  return parsed.toString().replace(/\/$/, "");
}
