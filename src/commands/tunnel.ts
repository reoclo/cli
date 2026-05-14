// src/commands/tunnel.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveServer } from "../client/resolve";
import { TunnelSession, type ForwardSpec } from "../client/tunnel-session";

export interface ParsedTunnelArgs {
  server: string;
  forwards: ForwardSpec[];
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

export interface ParseOptions {
  L?: string[];
  reconnectDeadline?: string;
  udp?: boolean;
}

export function parseTunnelArgs(server: string, opts: ParseOptions): ParsedTunnelArgs {
  const proto: "tcp" | "udp" = opts.udp ? "udp" : "tcp";
  const forwards = (opts.L ?? []).map((spec) => parseForwardSpec(spec, proto));
  if (forwards.length === 0) {
    throw new Error("at least one -L spec is required");
  }
  const deadlineSec = opts.reconnectDeadline ? Number(opts.reconnectDeadline) : 300;
  if (!Number.isFinite(deadlineSec) || deadlineSec < 0) {
    throw new Error(`invalid --reconnect-deadline: ${opts.reconnectDeadline}`);
  }
  return { server, forwards, reconnectDeadlineMs: deadlineSec * 1000 };
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
      "open a TCP/UDP tunnel from this machine through a Reoclo runner (forward; -L only)",
    )
    .option(
      "-L <spec>",
      "forward [bind:]local_port:remote_host:remote_port (repeat for multiple)",
      (value, prev: string[] = []) => [...prev, value],
      [] as string[],
    )
    .option(
      "--udp",
      "use UDP for all forwards in this invocation (default: TCP)",
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
