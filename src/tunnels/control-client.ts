// src/tunnels/control-client.ts
//
// What the CLI commands use to talk to the daemon over its Unix socket, and
// how they start it when nothing answers.

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { resolve } from "node:path";
import type { TunnelView } from "./manager";
import { logFile, runDir, socketPath, stateDir } from "./paths";

export class DaemonError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

export interface DaemonStatus {
  version: string;
  pid: number;
  uptime_seconds: number;
  state_dir: string;
  socket: string;
  tunnels: { total: number; enabled: number; by_state: Record<string, number> };
}

export class ControlClient {
  constructor(private readonly socket: string = socketPath()) {}

  async request<T>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`http://localhost${path}`, {
        method,
        unix: this.socket,
        headers: {
          "x-reoclo-client": "cli",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new DaemonError(
        "unreachable",
        `could not reach the tunnel daemon: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? {} : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const e = (parsed as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new DaemonError(e?.code ?? "error", e?.message ?? `the daemon answered ${res.status}`, res.status);
    }
    return parsed as T;
  }

  status(): Promise<DaemonStatus> {
    return this.request("GET", "/v1/status");
  }
  async tunnels(): Promise<TunnelView[]> {
    return (await this.request<{ tunnels: TunnelView[] }>("GET", "/v1/tunnels")).tunnels;
  }
  tunnel(name: string): Promise<TunnelView> {
    return this.request("GET", `/v1/tunnels/${encodeURIComponent(name)}`);
  }
  add(body: Record<string, unknown>): Promise<TunnelView> {
    return this.request("POST", "/v1/tunnels", body);
  }
  edit(name: string, body: Record<string, unknown>): Promise<TunnelView> {
    return this.request("PATCH", `/v1/tunnels/${encodeURIComponent(name)}`, body);
  }
  async remove(name: string): Promise<void> {
    await this.request("DELETE", `/v1/tunnels/${encodeURIComponent(name)}`);
  }
  up(name: string): Promise<TunnelView> {
    return this.request("POST", `/v1/tunnels/${encodeURIComponent(name)}/up`);
  }
  down(name: string): Promise<TunnelView> {
    return this.request("POST", `/v1/tunnels/${encodeURIComponent(name)}/down`);
  }
  async shutdown(): Promise<void> {
    await this.request("POST", "/v1/shutdown");
  }
}

/** True when a daemon answers on the socket. */
export async function daemonResponding(socket: string = socketPath(), timeoutMs = 500): Promise<boolean> {
  try {
    await new ControlClient(socket).request("GET", "/v1/status", undefined, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/**
 * The command that runs the daemon. A compiled binary re-runs itself; in dev
 * (`bun run src/index.ts`) the script path has to be passed along. Compiled
 * Bun binaries report a script path under /$bunfs/.
 */
export function daemonCommand(
  execPath: string = process.execPath,
  script: string | undefined = process.argv[1],
): { cmd: string; args: string[] } {
  const tail = ["tunnel", "daemon", "run"];
  if (script === undefined || script.startsWith("/$bunfs/") || script.startsWith("B:/~BUN")) {
    return { cmd: execPath, args: tail };
  }
  return { cmd: execPath, args: [resolve(script), ...tail] };
}

export interface SpawnResult {
  pid: number | undefined;
}

/** Start the daemon detached, with its output in tunneld.log. */
export function spawnDaemon(): SpawnResult & { exited: Promise<number | null> } {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  const fd = openSync(logFile(), "a", 0o600);
  const { cmd, args } = daemonCommand();
  const child = spawn(cmd, args, { detached: true, stdio: ["ignore", fd, fd], env: process.env });
  closeSync(fd);
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  child.unref();
  return { pid: child.pid, exited };
}

/** Wait until the daemon answers, or give up when it exits or the deadline passes. */
export async function waitForDaemon(
  exited: Promise<number | null>,
  socket: string = socketPath(),
  deadlineMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let gone: number | null | undefined;
  void exited.then((c) => {
    gone = c;
  });
  while (Date.now() < deadline) {
    if (await daemonResponding(socket, 250)) return;
    // A second daemon exits 0 because one is already running; keep polling for that one.
    if (gone !== undefined && gone !== 0) {
      throw new DaemonError("start_failed", `the tunnel daemon exited with code ${gone}; see ${logFile()}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new DaemonError("start_timeout", `the tunnel daemon did not start within ${Math.round(deadlineMs / 1000)}s; see ${logFile()}`);
}

/** A client for the running daemon, starting it first when nothing answers. */
export async function connectToDaemon(opts: { autoStart?: boolean } = {}): Promise<ControlClient> {
  const socket = socketPath();
  if (!(await daemonResponding(socket))) {
    if (opts.autoStart === false) throw new DaemonError("not_running", "the tunnel daemon is not running; start it with: reoclo tunnel daemon start");
    const { exited } = spawnDaemon();
    await waitForDaemon(exited, socket);
  }
  return new ControlClient(socket);
}
