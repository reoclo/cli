// src/commands/tunnel-daemon.ts
//
// `reoclo tunnel daemon run|start|stop|status|logs|install|uninstall`.

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { Command } from "commander";
import { globalOutput, printObject, resolveFormat } from "../ui/output";
import {
  ControlClient,
  daemonResponding,
  spawnDaemon,
  waitForDaemon,
  type DaemonStatus,
} from "../tunnels/control-client";
import { logFile, socketPath } from "../tunnels/paths";
import { installService, uninstallService } from "../tunnels/service";

function fail(err: unknown): never {
  console.error(`tunnel daemon: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

/** The last `lines` lines of `text`. */
export function lastLines(text: string, lines: number): string {
  const all = text.split("\n");
  if (all[all.length - 1] === "") all.pop();
  return all.slice(-lines).join("\n");
}

export function describeStatus(s: DaemonStatus): Record<string, unknown> {
  return {
    running: true,
    version: s.version,
    pid: s.pid,
    uptime_seconds: s.uptime_seconds,
    state_dir: s.state_dir,
    socket: s.socket,
    tunnels: s.tunnels.total,
    enabled: s.tunnels.enabled,
    ...Object.fromEntries(Object.entries(s.tunnels.by_state).filter(([, n]) => n > 0).map(([k, n]) => [`state_${k}`, n])),
    ...(s.https
      ? { https_port: s.https.port, https_listening: s.https.listening, ...(s.https.error ? { https_error: s.https.error } : {}) }
      : {}),
    ...(s.ca
      ? {
          ca_exists: s.ca.exists,
          ca_trusted: s.ca.trusted,
          ca_stale: s.ca.stale,
          ca_suffixes: s.ca.suffixes,
          ...(s.ca.not_after ? { ca_not_after: s.ca.not_after } : {}),
        }
      : {}),
    ...(s.hosts
      ? {
          hosts_helper_installed: s.hosts.installed,
          ...(s.hosts.version ? { hosts_helper_version: s.hosts.version } : {}),
          hosts_entries: s.hosts.entries,
          hosts_port_443_relay: s.hosts.relay.listening,
          hosts_suffixes: s.hosts.suffixes,
          hosts_relay_enabled: s.hosts.relay.enabled,
          hosts_relay_listening: s.hosts.relay.listening,
          ...(s.hosts.error ? { hosts_error: s.hosts.error } : {}),
        }
      : {}),
    ...(s.tailscale
      ? {
          tailscale_installed: s.tailscale.installed,
          tailscale_running: s.tailscale.running,
          ...(s.tailscale.state ? { tailscale_state: s.tailscale.state } : {}),
          ...(s.tailscale.tailnet ? { tailscale_tailnet: s.tailscale.tailnet } : {}),
          tailscale_https_certificates: s.tailscale.https_certificates,
          ...(s.tailscale.error ? { tailscale_error: s.tailscale.error } : {}),
        }
      : {}),
  };
}

async function waitUntilStopped(deadlineMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (!(await daemonResponding(socketPath(), 250))) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

export function registerTunnelDaemon(tunnelCmd: Command, program: Command): void {
  const daemon = tunnelCmd
    .command("daemon")
    .description("run and manage the tunnel daemon that keeps saved tunnels up");

  daemon
    .command("run")
    .description("run the daemon in the foreground (what start, launchd and systemd run)")
    .action(async () => {
      try {
        const { runDaemon } = await import("../tunnels/daemon");
        await runDaemon();
        process.exit(0);
      } catch (err) {
        fail(err);
      }
    });

  daemon
    .command("start")
    .description("start the daemon in the background")
    .action(async () => {
      try {
        if (await daemonResponding()) {
          const s = await new ControlClient().status();
          console.log(`tunnel daemon: already running (pid ${s.pid})`);
          return;
        }
        const { exited } = spawnDaemon();
        await waitForDaemon(exited);
        const s = await new ControlClient().status();
        console.log(`tunnel daemon: started (pid ${s.pid}), log ${logFile()}`);
      } catch (err) {
        fail(err);
      }
    });

  daemon
    .command("stop")
    .description("stop the daemon; saved tunnels keep their desired state and return on the next start")
    .action(async () => {
      try {
        if (!(await daemonResponding())) {
          console.log("tunnel daemon: not running");
          return;
        }
        await new ControlClient().shutdown();
        if (!(await waitUntilStopped())) throw new Error("the daemon did not stop within 10s");
        console.log("tunnel daemon: stopped");
      } catch (err) {
        fail(err);
      }
    });

  daemon
    .command("status")
    .description("show whether the daemon is running")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      if (!(await daemonResponding())) {
        if (fmt === "text") console.log("tunnel daemon: not running");
        else printObject({ running: false }, fmt);
        process.exit(1);
      }
      try {
        printObject(describeStatus(await new ControlClient().status()), fmt);
      } catch (err) {
        fail(err);
      }
    });

  daemon
    .command("logs")
    .description("print the daemon log")
    .option("-f, --follow", "keep printing new lines until interrupted", false)
    .option("-n, --lines <count>", "how many trailing lines to print first", "50")
    .action(async (opts: { follow?: boolean; lines: string }) => {
      const file = logFile();
      const count = Number(opts.lines);
      if (!Number.isInteger(count) || count < 0) {
        console.error(`tunnel daemon: invalid --lines: ${opts.lines}`);
        process.exit(2);
      }
      if (!existsSync(file)) {
        console.log(`tunnel daemon: no log yet at ${file}`);
        return;
      }
      const text = readFileSync(file, "utf8");
      const tail = lastLines(text, count);
      if (tail) console.log(tail);
      if (!opts.follow) return;
      let offset = Buffer.byteLength(text);
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          let size: number;
          try {
            size = statSync(file).size;
          } catch {
            return;
          }
          if (size < offset) offset = 0; // the log was truncated or replaced
          if (size === offset) return;
          const fd = openSync(file, "r");
          try {
            const buf = Buffer.alloc(size - offset);
            readSync(fd, buf, 0, buf.length, offset);
            process.stdout.write(buf);
            offset = size;
          } finally {
            closeSync(fd);
          }
        }, 250);
        process.once("SIGINT", () => {
          clearInterval(timer);
          resolve();
        });
      });
    });

  daemon
    .command("install")
    .description("start the daemon at login (a launchd agent on macOS, a systemd user unit on Linux)")
    .action(() => {
      try {
        console.log(`tunnel daemon: ${installService().message}`);
      } catch (err) {
        fail(err);
      }
    });

  daemon
    .command("uninstall")
    .description("stop starting the daemon at login")
    .action(() => {
      try {
        console.log(`tunnel daemon: ${uninstallService().message}`);
      } catch (err) {
        fail(err);
      }
    });
}
