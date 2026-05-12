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

function parseForwardSpec(spec: string): ForwardSpec {
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
    localPort = Number(parts[0]);
    remoteHost = "127.0.0.1";
    remotePort = Number(parts[1]);
  } else if (parts.length === 3) {
    localPort = Number(parts[0]);
    remoteHost = parts[1]!;
    remotePort = Number(parts[2]);
  } else if (parts.length === 4) {
    bind = parts[0]!;
    localPort = Number(parts[1]);
    remoteHost = parts[2]!;
    remotePort = Number(parts[3]);
  } else {
    throw new Error(`invalid -L spec: ${spec}`);
  }
  if (bind !== "127.0.0.1" && bind !== "0.0.0.0") {
    throw new Error(`invalid -L bind: ${bind} (only 127.0.0.1 or 0.0.0.0 supported)`);
  }
  if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535) {
    throw new Error(`invalid -L local_port: ${parts[parts.length === 4 ? 1 : 0]}`);
  }
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw new Error(`invalid -L remote_port: ${parts[parts.length - 1]}`);
  }
  return { localBind: bind, localPort, remoteHost, remotePort, proto: "tcp" };
}

export interface ParseOptions {
  L?: string[];
  reconnectDeadline?: string;
}

export function parseTunnelArgs(server: string, opts: ParseOptions): ParsedTunnelArgs {
  const forwards = (opts.L ?? []).map(parseForwardSpec);
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
      "open a TCP tunnel from this machine through a Reoclo runner (forward; -L only in Phase 1)",
    )
    .option(
      "-L <spec>",
      "forward [bind:]local_port:remote_host:remote_port (repeat for multiple)",
      (value, prev: string[] = []) => [...prev, value],
      [] as string[],
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

      const ctx = await bootstrap();
      const tenantId = requireTenantId(ctx);
      const serverId = await resolveServer(ctx.client, tenantId, parsed.server);

      // direct.reoclo.com bypass URL — CF-bypass host for tunnel traffic.
      // No dedicated directUrl field exists on the context yet; derive from
      // streamsUrl by replacing the "streams." subdomain with "direct.".
      const directUrl =
        process.env["REOCLO_DIRECT_URL"] ?? deriveDirectUrl(ctx.streamsUrl);

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

      const ready = await session.start();
      for (let i = 0; i < parsed.forwards.length; i++) {
        const f = parsed.forwards[i]!;
        const bound = ready.forwards[i]!;
        console.log(
          `-L  ${f.localBind}:${bound.boundPort}  →  ${idOrName}:${f.remoteHost}:${f.remotePort}  (tcp)`,
        );
      }
      console.log("Ctrl-C to close");

      process.on("SIGINT", async () => {
        await session.stop();
        process.exit(0);
      });
    });
}

function deriveDirectUrl(streamsUrl: string): string {
  // streams.reoclo.com → direct.reoclo.com  (same scheme + path conventions)
  return streamsUrl.replace("streams.", "direct.");
}
