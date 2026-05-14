// src/commands/tunnel.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveServer } from "../client/resolve";
import { TunnelSession, type ForwardSpec, type ReverseSpec } from "../client/tunnel-session";

export interface ParsedTunnelArgs {
  server: string;
  forwards: ForwardSpec[];
  reverses: ReverseSpec[];
  reconnectDeadlineMs: number;
}

function parseDecimalInt(s: string, name: string): number {
  if (!/^\d+$/.test(s)) {
    throw new Error(`invalid -L ${name}: ${JSON.stringify(s)} (expected non-negative decimal integer)`);
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
    localPort = parseDecimalInt(parts[0]!, "local_port");
    remoteHost = "127.0.0.1";
    remotePort = parseDecimalInt(parts[1]!, "remote_port");
  } else if (parts.length === 3) {
    localPort = parseDecimalInt(parts[0]!, "local_port");
    remoteHost = parts[1]!;
    remotePort = parseDecimalInt(parts[2]!, "remote_port");
  } else if (parts.length === 4) {
    bind = parts[0]!;
    localPort = parseDecimalInt(parts[1]!, "local_port");
    remoteHost = parts[2]!;
    remotePort = parseDecimalInt(parts[3]!, "remote_port");
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
    remotePort = parseDecimalInt(parts[0]!, "remote_port");
    localHost = "127.0.0.1";
    localPort = parseDecimalInt(parts[1]!, "local_port");
  } else if (parts.length === 3) {
    remotePort = parseDecimalInt(parts[0]!, "remote_port");
    localHost = parts[1]!;
    localPort = parseDecimalInt(parts[2]!, "local_port");
  } else if (parts.length === 4) {
    if (parts[0] !== "127.0.0.1" && parts[0] !== "0.0.0.0") {
      throw new Error(`invalid -R bind: ${parts[0]} (only 127.0.0.1 or 0.0.0.0 supported)`);
    }
    bind = parts[0] as "127.0.0.1" | "0.0.0.0";
    remotePort = parseDecimalInt(parts[1]!, "remote_port");
    localHost = parts[2]!;
    localPort = parseDecimalInt(parts[3]!, "local_port");
  } else {
    throw new Error(`invalid -R spec: ${spec}`);
  }
  if (bind === "0.0.0.0" && !bindPublicAllowed) {
    throw new Error(`invalid -R bind: 0.0.0.0 requires --bind-public flag`);
  }
  if (remotePort < 0 || remotePort > 65535) {
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
  program
    .command("tunnel <serverIdOrName>")
    .description(
      "open a TCP/UDP tunnel through a Reoclo runner (forward -L or reverse -R)",
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
    .action(async (idOrName: string, rawOpts: ParseOptions) => {
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
