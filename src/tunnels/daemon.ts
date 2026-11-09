// src/tunnels/daemon.ts
//
// The tunnel daemon process: one per user. `reoclo tunnel daemon run` ends up
// here. It takes the pid lock, serves the control API, restores every enabled
// tunnel, and shuts down cleanly on SIGINT or SIGTERM.

import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import pkg from "../../package.json" with { type: "json" };
import { bootstrap } from "../client/bootstrap";
import { TunnelSession } from "../client/tunnel-session";
import { buildTunnelSessionOptions, buildTunnelWsUrl, deriveDirectUrl } from "../commands/tunnel";
import { daemonResponding } from "./control-client";
import { startControlServer } from "./control-server";
import { TunnelManager, type PoolKey } from "./manager";
import { logFile, pidFile, runDir, socketPath, stateDir, tunnelsFile } from "./paths";
import { ServerPool, type PoolLike, type SessionFactory } from "./pool";
import { DAEMON_FATAL_CODES } from "./states";

export class AlreadyRunningError extends Error {
  constructor(readonly pid: number) {
    super(`a tunnel daemon is already running (pid ${pid})`);
    this.name = "AlreadyRunningError";
  }
}

export interface DaemonOptions {
  /** Where gateway WebSockets connect. Defaults to $REOCLO_DIRECT_URL, then the URL derived from the profile. */
  directUrl?: string;
  /** Replace how pools are built (tests). */
  createPool?: (key: PoolKey, idleTimeoutMs: number) => PoolLike;
  log?: (line: string) => void;
  version?: string;
  trafficIntervalMs?: number;
}

export interface DaemonHandle {
  manager: TunnelManager;
  socketPath: string;
  /** Resolves when something asks the daemon to shut down. */
  shutdownRequested: Promise<void>;
  stop(): Promise<void>;
}

/** The real session factory: sign in for the pool's org on every open, then dial the gateway. */
export function gatewaySessionFactory(key: PoolKey, directUrl?: string): SessionFactory {
  return async (onStatus) => {
    // Auth per session open: start from the stored, refreshed profile token.
    const ctx = await bootstrap({ org: key.org, profile: key.profile });
    const base = directUrl ?? process.env["REOCLO_DIRECT_URL"] ?? deriveDirectUrl(ctx.streamsUrl);
    const gatewayUrl = buildTunnelWsUrl(base, key.server_id);
    return new TunnelSession({
      // ctx.refresh goes through by reference; see buildTunnelSessionOptions.
      ...buildTunnelSessionOptions(
        ctx,
        gatewayUrl,
        { server: key.server_id, forwards: [], reverses: [], reconnectDeadlineMs: 5 * 60_000 },
        onStatus,
      ),
      extraFatalCodes: DAEMON_FATAL_CODES,
    });
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Take the single-instance lock: an exclusive pid file, stolen only when its owner is gone. */
async function takePidLock(path: string, socket: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const owner = Number(readFileSync(path, "utf8").trim());
    if (owner > 0 && owner !== process.pid && pidAlive(owner)) {
      // The owner may still be starting; give its socket a moment before calling the lock stale.
      const deadline = Date.now() + 2000;
      do {
        if (await daemonResponding(socket, 250)) throw new AlreadyRunningError(owner);
        await new Promise((r) => setTimeout(r, 50));
      } while (Date.now() < deadline && pidAlive(owner));
      if (pidAlive(owner) && (await daemonResponding(socket, 250))) throw new AlreadyRunningError(owner);
    }
    rmSync(path, { force: true });
  }
  throw new Error(`could not take the daemon lock at ${path}`);
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`));
  const socket = socketPath();
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  chmodSync(runDir(), 0o700);
  await takePidLock(pidFile(), socket);

  const startedAt = Date.now();
  const version = opts.version ?? pkg.version;
  let requestShutdown: () => void = () => undefined;
  const shutdownRequested = new Promise<void>((r) => {
    requestShutdown = r;
  });

  try {
    const manager = new TunnelManager({
      configPath: tunnelsFile(),
      log,
      createPool:
        opts.createPool ??
        ((key, idleTimeoutMs) =>
          new ServerPool({ createSession: gatewaySessionFactory(key, opts.directUrl), idleTimeoutMs })),
    });
    const server = startControlServer({
      socketPath: socket,
      manager,
      version,
      startedAt,
      stateDir: stateDir(),
      log,
      onShutdown: requestShutdown,
      trafficIntervalMs: opts.trafficIntervalMs,
    });
    await manager.start();
    log(`tunnel daemon ${version} listening on ${socket} (pid ${process.pid}, log ${logFile()})`);

    let stopped: Promise<void> | undefined;
    return {
      manager,
      socketPath: socket,
      shutdownRequested,
      stop() {
        stopped ??= (async () => {
          await manager.stop();
          await server.stop();
          rmSync(pidFile(), { force: true });
          log("tunnel daemon stopped");
        })();
        return stopped;
      },
    };
  } catch (err) {
    rmSync(pidFile(), { force: true });
    throw err;
  }
}

/** Entry for `reoclo tunnel daemon run`: start, then wait for a signal or a shutdown request. */
export async function runDaemon(): Promise<void> {
  let handle: DaemonHandle;
  try {
    handle = await startDaemon();
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      process.stderr.write(`${err.message}\n`);
      return;
    }
    throw err;
  }
  const signalled = new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await Promise.race([signalled, handle.shutdownRequested]);
  await handle.stop();
}
