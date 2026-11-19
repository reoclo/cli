// src/tunnels/daemon.ts
//
// The tunnel daemon process: one per user. `reoclo tunnel daemon run` ends up
// here. It takes the pid lock, serves the control API, restores every enabled
// tunnel, and shuts down cleanly on SIGINT or SIGTERM.

import { chmodSync, closeSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import pkg from "../../package.json" with { type: "json" };
import { bootstrap } from "../client/bootstrap";
import { TunnelSession } from "../client/tunnel-session";
import { buildTunnelSessionOptions, buildTunnelWsUrl, deriveDirectUrl } from "../commands/tunnel";
import { createAuthFlow, type AuthFlow } from "./auth-flow";
import { LeafIssuer, type CertSource } from "./ca";
import { localCaActions, type CaActions } from "./ca-actions";
import { daemonResponding } from "./control-client";
import { startControlServer, type ControlServerOptions } from "./control-server";
import { ApiDirectory, type Directory } from "./directory";
import { HostsClient, hostsHelperAllowed, type HostsSink } from "./hosts-client";
import { lockOwner, pidAlive, processKind, stopProcess, type ProcessKind } from "./instance";
import { TunnelManager, type PoolKey } from "./manager";
import type { ShareSpawner } from "./shares";
import type { Tailscale } from "./tailscale";
import { caCertFile, logFile, pidFile, runDir, sharesFile, socketPath, stateDir, tunnelsFile } from "./paths";
import { checkTrust, defaultTrustEnv } from "./trust";
import { ServerPool, type PoolLike, type SessionFactory, type Timers } from "./pool";
import { daemonExecutable } from "./service";
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
  /** Replace the certificate source (tests). Defaults to the local CA under the state directory. */
  certs?: CertSource;
  /** Replace the hosts helper client (tests). */
  hosts?: HostsSink;
  /** Replace the Reoclo API lookups behind the orgs, servers and ad-hoc routes (tests). */
  directory?: Directory;
  /** Replace the Tailscale CLI reader (tests). */
  tailscale?: Tailscale;
  /** Replace how a share's `tailscale serve` child is started (tests). */
  spawnShare?: ShareSpawner;
  /** Replace the device-flow sign-in (tests). */
  auth?: AuthFlow;
  /** Replace CA trust and untrust, which change the system trust store (tests). */
  caActions?: CaActions;
  /** Approval clock, timers, expiry and ids (tests). */
  approvals?: ControlServerOptions["approvals"];
  /** Longest wait for a session to open when a caller asks to verify the connection (tests). */
  connectTimeoutMs?: number;
  /** Timers for ad-hoc tunnel expiry and keep-up retries (tests). */
  timers?: Timers;
  log?: (line: string) => void;
  version?: string;
  trafficIntervalMs?: number;
  /** How often the daemon checks it still holds the lock (tests). */
  ownershipCheckMs?: number;
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

/** How long a daemon that holds the lock gets to answer before it counts as stuck. A start with tunnels to bring up has taken 27 seconds. */
const OWNER_ANSWER_MS = 30_000;
const OWNERSHIP_CHECK_MS = 5_000;
/** A check this late means something blocked the event loop; it is logged so the cause can be found. */
const STALL_LOG_MS = 2_000;

export interface LockOptions {
  log?: (line: string) => void;
  /** Replace the process checks, the liveness probe and the wait (tests). */
  alive?: (pid: number) => boolean;
  kind?: (pid: number) => Promise<ProcessKind>;
  responding?: (socket: string) => Promise<boolean>;
  stop?: (pid: number) => Promise<boolean>;
  answerWaitMs?: number;
}

/**
 * Take the single-instance lock, an exclusive pid file. A holder that is gone, or whose pid now
 * belongs to another program, loses it. A daemon keeps it while it answers on the socket; one that
 * stays silent is stopped first, so a second daemon never runs beside it holding the same ports.
 */
export async function takePidLock(path: string, socket: string, o: LockOptions = {}): Promise<void> {
  const alive = o.alive ?? pidAlive;
  const responding = o.responding ?? ((s: string) => daemonResponding(s, 1_000));
  const waitMs = o.answerWaitMs ?? OWNER_ANSWER_MS;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const owner = lockOwner(path);
    if (owner !== undefined && owner !== process.pid && alive(owner)) {
      const kind = await (o.kind ?? processKind)(owner);
      if (kind !== "other") {
        const deadline = Date.now() + waitMs;
        do {
          if (await responding(socket)) throw new AlreadyRunningError(owner);
          await new Promise((r) => setTimeout(r, 250));
        } while (Date.now() < deadline && alive(owner));
        // A holder whose command line cannot be read is never stopped; the lock passes as it always has.
        if (kind === "daemon" && alive(owner)) {
          o.log?.(`tunnel daemon pid ${owner} has not answered for ${Math.round(waitMs / 1000)}s; stopping it`);
          if (!(await (o.stop ?? stopProcess)(owner))) {
            throw new Error(`could not stop tunnel daemon pid ${owner}, which holds ${path} and does not answer`);
          }
        }
      }
    }
    rmSync(path, { force: true });
  }
  throw new Error(`could not take the daemon lock at ${path}`);
}

/** Remove the pid file only while it still names this process; a daemon that took over owns it now. */
function releasePidLock(path: string): void {
  if (lockOwner(path) === process.pid) rmSync(path, { force: true });
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`));
  const socket = socketPath();
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  chmodSync(runDir(), 0o700);
  await takePidLock(pidFile(), socket, { log });

  const startedAt = Date.now();
  const version = opts.version ?? pkg.version;
  let requestShutdown: () => void = () => undefined;
  const shutdownRequested = new Promise<void>((r) => {
    requestShutdown = r;
  });

  // A daemon that lost its lock would otherwise keep every tunnel's port while the new one fails to bind them.
  const checkMs = opts.ownershipCheckMs ?? OWNERSHIP_CHECK_MS;
  let lastCheck = Date.now();
  let replaced = false;
  const watch = setInterval(() => {
    const now = Date.now();
    const late = now - lastCheck - checkMs;
    lastCheck = now;
    if (late > STALL_LOG_MS) log(`the daemon was blocked for ${(late / 1000).toFixed(1)}s`);
    const owner = lockOwner(pidFile());
    if (!replaced && owner !== undefined && owner !== process.pid) {
      replaced = true;
      log(`tunnel daemon pid ${owner} holds ${pidFile()} now; shutting down to free this daemon's ports`);
      requestShutdown();
    }
  }, checkMs);
  watch.unref();

  try {
    const directory = opts.directory ?? new ApiDirectory();
    const manager = new TunnelManager({
      configPath: tunnelsFile(),
      sharesFile: sharesFile(),
      tailscale: opts.tailscale,
      spawnShare: opts.spawnShare,
      portScan: (cfg) => directory.ports(cfg.org, cfg.server_id, cfg.profile),
      log,
      certs:
        opts.certs ??
        new LeafIssuer({
          checkTrusted: (ca) => checkTrust(defaultTrustEnv(), { certPath: caCertFile(), certPem: ca.certPem }),
        }),
      hosts: opts.hosts ?? (hostsHelperAllowed() ? new HostsClient() : undefined),
      connectTimeoutMs: opts.connectTimeoutMs,
      timers: opts.timers,
      createPool:
        opts.createPool ??
        ((key, idleTimeoutMs) =>
          new ServerPool({ createSession: gatewaySessionFactory(key, opts.directUrl), idleTimeoutMs })),
    });
    const server = startControlServer({
      socketPath: socket,
      manager,
      version,
      executable: daemonExecutable(),
      startedAt,
      stateDir: stateDir(),
      log,
      onShutdown: requestShutdown,
      trafficIntervalMs: opts.trafficIntervalMs,
      directory,
      auth: opts.auth ?? createAuthFlow(),
      caActions: opts.caActions ?? localCaActions,
      approvals: opts.approvals,
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
          clearInterval(watch);
          await manager.stop();
          await server.stop();
          releasePidLock(pidFile());
          log("tunnel daemon stopped");
        })();
        return stopped;
      },
    };
  } catch (err) {
    clearInterval(watch);
    releasePidLock(pidFile());
    throw err;
  }
}

/** Entry for `reoclo tunnel daemon run`: start, then wait for a signal or a shutdown request. */
export async function runDaemon(): Promise<void> {
  // The daemon outlives the shell that started it, often a worktree that is deleted later, and Bun
  // shell commands (the keychain read behind every sign-in) fail with ENOENT from a deleted directory.
  process.chdir(homedir());
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
