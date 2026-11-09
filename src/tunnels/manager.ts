// src/tunnels/manager.ts
//
// Owns the local side of every saved tunnel: the listener for each enabled
// forward tunnel, the keep-up hold and reverse listener for the others. It
// routes accepted sockets and datagrams into the right server pool, derives
// each tunnel's state, persists desired state, and emits events.

import dgram from "node:dgram";
import net from "node:net";
import {
  ConfigError,
  isReverse,
  loadConfig,
  parseTunnel,
  updateConfig,
  type ForwardTunnel,
  type SavedTunnel,
  type TunnelsFile,
} from "./config";
import { tunnelsFile } from "./paths";
import { PoolError, type Lease, type PoolLike, type PoolState, type Timers } from "./pool";
import { isFailureState, reportFor, type StateReport, type TunnelState } from "./states";

export interface PoolKey {
  org: string;
  tenant_id: string;
  server_id: string;
  profile?: string;
}

export interface TunnelTraffic {
  bytes_in: number;
  bytes_out: number;
  streams: number;
}

export interface TunnelView extends StateReport {
  name: string;
  org: string;
  server: string;
  server_id: string;
  kind: SavedTunnel["kind"];
  keep_up: boolean;
  enabled: boolean;
  /** Forward tunnels: where this machine listens, e.g. 127.0.0.1:15432. */
  endpoint?: string;
  target?: string;
  local_port?: number;
  remote_port?: number;
  local_target?: string;
  bind_public?: boolean;
  traffic: TunnelTraffic;
}

export type ManagerEvent =
  | { type: "tunnel"; name: string; removed?: boolean; tunnel?: TunnelView }
  | { type: "log"; line: string };

export class ManagerError extends Error {
  constructor(
    readonly code: "invalid" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "ManagerError";
  }
}

export interface ManagerOptions {
  createPool: (key: PoolKey, idleTimeoutMs: number) => PoolLike;
  configPath?: string;
  log?: (line: string) => void;
  timers?: Timers;
  /** Longest wait between keep-up reconnect attempts. Default 30 s. */
  maxBackoffMs?: number;
  /** Choose a local port for a forward tunnel saved without one. */
  pickPort?: (preferred: number, used: ReadonlySet<number>) => Promise<number>;
}

interface PoolEntry {
  pool: PoolLike;
  unsubscribe: () => void;
  users: Set<Runtime>;
}

interface Runtime {
  cfg: SavedTunnel;
  active: boolean;
  entry?: PoolEntry;
  server?: net.Server;
  udp?: dgram.Socket;
  sockets: Set<net.Socket>;
  closedIn: number;
  closedOut: number;
  /** Keep-up hold (forward) or reverse hold. */
  lease?: Lease;
  reverseId?: string;
  connecting: boolean;
  attempt: number;
  retryTimer?: unknown;
  /** The local listener could not bind. */
  localError?: string;
  /** The runner refused the reverse listener. */
  failure?: { state: "failed" | "forbidden"; detail: string };
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function splitHostPort(value: string): { host: string; port: number } {
  const i = value.lastIndexOf(":");
  return { host: value.slice(0, i), port: Number(value.slice(i + 1)) };
}

function listenOnce(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

/** The preferred port when it is set and free on 127.0.0.1, else a free ephemeral port. */
export async function pickLocalPort(
  preferred: number,
  used: ReadonlySet<number> = new Set(),
): Promise<number> {
  if (preferred > 0 && !used.has(preferred)) {
    try {
      const s = await listenOnce(preferred);
      await new Promise<void>((r) => s.close(() => r()));
      return preferred;
    } catch {
      /* in use: fall through to an ephemeral port */
    }
  }
  for (;;) {
    const s = await listenOnce(0);
    const port = (s.address() as net.AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    if (!used.has(port)) return port;
  }
}

export class TunnelManager {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly pools = new Map<string, PoolEntry>();
  private readonly subscribers = new Set<(e: ManagerEvent) => void>();
  private readonly timers: Timers;
  private file: TunnelsFile;
  private stopping = false;

  constructor(private readonly opts: ManagerOptions) {
    this.timers = opts.timers ?? realTimers;
    this.file = loadConfig(this.path);
  }

  private get path(): string {
    return this.opts.configPath ?? tunnelsFile();
  }

  private log(line: string): void {
    this.opts.log?.(line);
    this.emit({ type: "log", line });
  }

  onEvent(fn: (e: ManagerEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private emit(e: ManagerEvent): void {
    for (const fn of [...this.subscribers]) fn(e);
  }

  /** Load the saved tunnels and bring every enabled one up. */
  async start(): Promise<void> {
    this.file = loadConfig(this.path);
    for (const cfg of this.file.tunnels) this.runtimes.set(cfg.name, this.newRuntime(cfg));
    for (const rt of this.runtimes.values()) {
      if (rt.cfg.enabled) await this.activate(rt);
    }
  }

  /** Tear everything down without touching the saved desired state. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const rt of this.runtimes.values()) await this.deactivate(rt);
    for (const entry of [...this.pools.values()]) await this.disposePool(entry);
  }

  list(): TunnelView[] {
    return [...this.runtimes.values()]
      .map((rt) => this.view(rt))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): TunnelView {
    return this.view(this.require(name));
  }

  /** Every tunnel's traffic, for the once-a-second event. Empty when nothing is active. */
  trafficSnapshot(): { name: string; traffic: TunnelTraffic }[] {
    const out: { name: string; traffic: TunnelTraffic }[] = [];
    for (const rt of this.runtimes.values()) {
      if (this.stateOf(rt).state === "active") out.push({ name: rt.cfg.name, traffic: this.traffic(rt) });
    }
    return out;
  }

  // ── mutations ────────────────────────────────────────────────────────────

  async add(input: unknown): Promise<TunnelView> {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new ManagerError("invalid", "the tunnel must be an object");
    }
    const raw = { ...(input as Record<string, unknown>) };
    const name = typeof raw["name"] === "string" ? raw["name"] : "";
    if (this.runtimes.has(name)) throw new ManagerError("conflict", `a tunnel named "${name}" already exists`);
    if ((raw["kind"] === "tcp" || raw["kind"] === "udp") && raw["local_port"] === undefined) {
      const target = typeof raw["target"] === "string" ? raw["target"] : "";
      const preferred = /:\d+$/.test(target) ? splitHostPort(target).port : 0;
      raw["local_port"] = await (this.opts.pickPort ?? pickLocalPort)(preferred, this.usedPorts());
    }
    const cfg = this.parse(raw);
    await this.save((file) => {
      if (file.tunnels.some((t) => t.name === cfg.name)) {
        throw new ManagerError("conflict", `a tunnel named "${cfg.name}" already exists`);
      }
      file.tunnels.push(cfg);
    });
    const rt = this.newRuntime(cfg);
    this.runtimes.set(cfg.name, rt);
    if (cfg.enabled) await this.activate(rt);
    else this.emitTunnel(rt);
    return this.view(rt);
  }

  async edit(name: string, patch: unknown): Promise<TunnelView> {
    const rt = this.require(name);
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
      throw new ManagerError("invalid", "the change must be an object");
    }
    const changes = patch as Record<string, unknown>;
    if ("name" in changes && changes["name"] !== name) throw new ManagerError("invalid", "a tunnel cannot be renamed; remove it and add it again");
    if ("kind" in changes && changes["kind"] !== rt.cfg.kind) throw new ManagerError("invalid", "a tunnel cannot change kind; remove it and add it again");
    const cfg = this.parse({ ...rt.cfg, ...changes, name, kind: rt.cfg.kind });
    await this.save((file) => {
      const i = file.tunnels.findIndex((t) => t.name === name);
      if (i < 0) throw new ManagerError("not_found", `no tunnel named "${name}"`);
      file.tunnels[i] = cfg;
    });
    const wasActive = rt.active;
    await this.deactivate(rt);
    rt.cfg = cfg;
    if (wasActive && cfg.enabled) await this.activate(rt);
    else this.emitTunnel(rt);
    return this.view(rt);
  }

  async remove(name: string): Promise<void> {
    const rt = this.require(name);
    await this.deactivate(rt);
    await this.save((file) => {
      file.tunnels = file.tunnels.filter((t) => t.name !== name);
    });
    this.runtimes.delete(name);
    this.emit({ type: "tunnel", name, removed: true });
  }

  async up(name: string): Promise<TunnelView> {
    const rt = this.require(name);
    if (!rt.cfg.enabled) {
      rt.cfg = { ...rt.cfg, enabled: true };
      await this.save((file) => this.replace(file, rt.cfg));
    }
    // Any `up` on a server's tunnels clears an expired or operator-closed state for the whole pool.
    rt.localError = undefined;
    rt.failure = undefined;
    await this.activate(rt, { reset: true });
    return this.view(rt);
  }

  async down(name: string): Promise<TunnelView> {
    const rt = this.require(name);
    if (rt.cfg.enabled) {
      rt.cfg = { ...rt.cfg, enabled: false };
      await this.save((file) => this.replace(file, rt.cfg));
    }
    await this.deactivate(rt);
    return this.view(rt);
  }

  // ── lifecycle of one tunnel ──────────────────────────────────────────────

  private async activate(rt: Runtime, o: { reset?: boolean } = {}): Promise<void> {
    rt.active = true;
    const entry = this.ensurePool(rt);
    if (o.reset) entry.pool.reset();
    const cfg = rt.cfg;
    if (!isReverse(cfg)) await this.bind(rt, cfg);
    if (isReverse(cfg) || cfg.keep_up) void this.connectHeld(rt);
    this.emitTunnel(rt);
  }

  private async deactivate(rt: Runtime): Promise<void> {
    rt.active = false;
    if (rt.retryTimer !== undefined) {
      this.timers.clear(rt.retryTimer);
      rt.retryTimer = undefined;
    }
    rt.attempt = 0;
    rt.localError = undefined;
    rt.failure = undefined;
    for (const sock of [...rt.sockets]) sock.destroy();
    const server = rt.server;
    rt.server = undefined;
    if (server) await new Promise<void>((r) => server.close(() => r()));
    const udp = rt.udp;
    rt.udp = undefined;
    if (udp) await new Promise<void>((r) => udp.close(() => r()));
    if (rt.reverseId !== undefined) rt.lease?.session.removeReverse(rt.reverseId);
    rt.reverseId = undefined;
    rt.lease?.release();
    rt.lease = undefined;
    const entry = rt.entry;
    rt.entry = undefined;
    if (entry) {
      entry.users.delete(rt);
      if (entry.users.size === 0) await this.disposePool(entry);
    }
    if (!this.stopping) this.emitTunnel(rt);
  }

  // ── pools ────────────────────────────────────────────────────────────────

  private poolKey(cfg: SavedTunnel): string {
    return [cfg.profile ?? "", cfg.org, cfg.server_id].join("\u0000");
  }

  private ensurePool(rt: Runtime): PoolEntry {
    if (rt.entry) return rt.entry;
    const key = this.poolKey(rt.cfg);
    let entry = this.pools.get(key);
    if (!entry) {
      const pool = this.opts.createPool(
        { org: rt.cfg.org, tenant_id: rt.cfg.tenant_id, server_id: rt.cfg.server_id, profile: rt.cfg.profile },
        this.file.idle_timeout_seconds * 1000,
      );
      const created: PoolEntry = { pool, unsubscribe: () => undefined, users: new Set() };
      created.unsubscribe = pool.onChange((s) => this.onPoolChange(created, s));
      this.pools.set(key, created);
      entry = created;
    }
    entry.users.add(rt);
    rt.entry = entry;
    return entry;
  }

  private async disposePool(entry: PoolEntry): Promise<void> {
    entry.unsubscribe();
    for (const [k, v] of this.pools) if (v === entry) this.pools.delete(k);
    await entry.pool.stop();
  }

  private onPoolChange(entry: PoolEntry, state: PoolState): void {
    this.log(`pool ${[...entry.users].map((u) => u.cfg.name).join(",")}: ${state.state}${state.detail ? ` (${state.detail})` : ""}`);
    for (const rt of entry.users) {
      if (isFailureState(state.state)) {
        // The session is gone for good: its leases are void.
        rt.lease = undefined;
        rt.reverseId = undefined;
        // Only a lost connection is worth retrying; sign-in, permission, quota and terminal states need someone to act.
        if (this.holdsSession(rt) && (state.state === "server_offline" || state.state === "failed")) {
          this.scheduleRetry(rt);
        }
      }
      this.emitTunnel(rt);
    }
  }

  private holdsSession(rt: Runtime): boolean {
    return rt.active && (isReverse(rt.cfg) || rt.cfg.keep_up);
  }

  // ── keep-up and reverse holds ────────────────────────────────────────────

  private async connectHeld(rt: Runtime): Promise<void> {
    const entry = rt.entry;
    if (!entry || rt.connecting || rt.lease) return;
    rt.connecting = true;
    try {
      const lease = await entry.pool.acquire("hold");
      if (!rt.active || rt.entry !== entry) {
        lease.release();
        return;
      }
      rt.lease = lease;
      const cfg = rt.cfg;
      if (isReverse(cfg)) {
        const local = splitHostPort(cfg.local_target);
        rt.reverseId = await lease.session.addReverse({
          remoteBind: cfg.bind_public ? "0.0.0.0" : "127.0.0.1",
          remotePort: cfg.remote_port,
          localHost: local.host,
          localPort: local.port,
          proto: "tcp",
        });
      }
      rt.attempt = 0;
    } catch (err) {
      if (err instanceof PoolError) {
        if (rt.active && (err.state === "server_offline" || err.state === "failed" || err.state === "reconnecting")) {
          this.scheduleRetry(rt);
        }
      } else {
        // The runner answered but refused the reverse listener: show why and stop retrying.
        const detail = err instanceof Error ? err.message : String(err);
        rt.lease?.release();
        rt.lease = undefined;
        rt.failure = {
          state: /forbid|denied|not allowed|disabled|polic/i.test(detail) ? "forbidden" : "failed",
          detail,
        };
        this.log(`tunnel ${rt.cfg.name}: ${detail}`);
      }
    } finally {
      rt.connecting = false;
      this.emitTunnel(rt);
    }
  }

  private scheduleRetry(rt: Runtime): void {
    if (rt.retryTimer !== undefined || !rt.active) return;
    const max = this.opts.maxBackoffMs ?? 30_000;
    const delay = Math.min(max, 1000 * 2 ** rt.attempt);
    rt.attempt++;
    rt.retryTimer = this.timers.set(() => {
      rt.retryTimer = undefined;
      if (rt.active) void this.connectHeld(rt);
    }, delay);
  }

  // ── local listeners ──────────────────────────────────────────────────────

  private async bind(rt: Runtime, cfg: ForwardTunnel): Promise<void> {
    if (rt.server || rt.udp) return;
    rt.localError = undefined;
    const target = splitHostPort(cfg.target);
    const remote = { remoteHost: target.host, remotePort: target.port };
    try {
      if (cfg.kind === "tcp") {
        const server = net.createServer((sock) => this.onAccept(rt, sock, remote));
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(cfg.local_port, "127.0.0.1", () => resolve());
        });
        server.on("error", (err) => this.log(`tunnel ${cfg.name}: listener error: ${err.message}`));
        rt.server = server;
      } else {
        const sock = dgram.createSocket("udp4");
        await new Promise<void>((resolve, reject) => {
          sock.once("error", reject);
          sock.bind(cfg.local_port, "127.0.0.1", () => resolve());
        });
        sock.on("error", (err) => this.log(`tunnel ${cfg.name}: socket error: ${err.message}`));
        sock.on("message", (buf, rinfo) => this.onDatagram(rt, sock, buf, rinfo, remote));
        rt.udp = sock;
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      rt.localError =
        e.code === "EADDRINUSE"
          ? `local port ${cfg.local_port} is already in use`
          : `could not listen on 127.0.0.1:${cfg.local_port}: ${e.message}`;
      this.log(`tunnel ${cfg.name}: ${rt.localError}`);
    }
  }

  private onAccept(
    rt: Runtime,
    sock: net.Socket,
    remote: { remoteHost: string; remotePort: number },
  ): void {
    const pool = rt.entry?.pool;
    sock.on("error", () => sock.destroy());
    // Hold the bytes until the session is open: send() drops frames before that.
    sock.pause();
    rt.sockets.add(sock);
    sock.once("close", () => {
      rt.sockets.delete(sock);
      rt.closedIn += sock.bytesWritten;
      rt.closedOut += sock.bytesRead;
    });
    if (!pool) {
      sock.destroy();
      return;
    }
    pool.acquire("stream").then(
      (lease) => {
        if (sock.destroyed) {
          lease.release();
          return;
        }
        sock.once("close", () => lease.release());
        lease.session.attachTcpSocket(sock, remote);
        sock.resume();
      },
      (err: unknown) => {
        this.log(`tunnel ${rt.cfg.name}: connection refused: ${err instanceof Error ? err.message : String(err)}`);
        sock.destroy();
      },
    );
  }

  private onDatagram(
    rt: Runtime,
    listener: dgram.Socket,
    buf: Buffer,
    rinfo: dgram.RemoteInfo,
    remote: { remoteHost: string; remotePort: number },
  ): void {
    const pool = rt.entry?.pool;
    if (!pool) return;
    const session = pool.activeSession();
    if (session) {
      pool.touch();
      rt.closedOut += buf.length;
      session.forwardUdpDatagram(buf, rinfo, remote, listener);
      return;
    }
    // Open the session for the next datagram; this one is dropped, as UDP allows.
    pool.acquire("stream").then(
      (lease) => lease.release(),
      () => undefined,
    );
  }

  // ── views ────────────────────────────────────────────────────────────────

  private newRuntime(cfg: SavedTunnel): Runtime {
    return { cfg, active: false, sockets: new Set(), closedIn: 0, closedOut: 0, connecting: false, attempt: 0 };
  }

  private require(name: string): Runtime {
    const rt = this.runtimes.get(name);
    if (!rt) throw new ManagerError("not_found", `no tunnel named "${name}"`);
    return rt;
  }

  private parse(raw: unknown): SavedTunnel {
    try {
      const cfg = parseTunnel(raw);
      const used = this.usedPorts(typeof (raw as { name?: unknown }).name === "string" ? (raw as { name: string }).name : undefined);
      if (cfg.kind !== "reverse" && used.has(cfg.local_port)) {
        throw new ManagerError("conflict", `local port ${cfg.local_port} is already used by another saved tunnel`);
      }
      return cfg;
    } catch (err) {
      if (err instanceof ConfigError) throw new ManagerError("invalid", err.message);
      throw err;
    }
  }

  private usedPorts(except?: string): Set<number> {
    const used = new Set<number>();
    for (const rt of this.runtimes.values()) {
      if (rt.cfg.name !== except && rt.cfg.kind !== "reverse") used.add(rt.cfg.local_port);
    }
    return used;
  }

  private replace(file: TunnelsFile, cfg: SavedTunnel): void {
    const i = file.tunnels.findIndex((t) => t.name === cfg.name);
    if (i >= 0) file.tunnels[i] = cfg;
  }

  private async save(fn: (file: TunnelsFile) => void): Promise<void> {
    try {
      this.file = await updateConfig((file) => {
        fn(file);
        return file;
      }, this.path);
    } catch (err) {
      if (err instanceof ConfigError) throw new ManagerError("invalid", err.message);
      throw err;
    }
  }

  private traffic(rt: Runtime): TunnelTraffic {
    let live_in = 0;
    let live_out = 0;
    for (const s of rt.sockets) {
      live_in += s.bytesWritten;
      live_out += s.bytesRead;
    }
    return { bytes_in: rt.closedIn + live_in, bytes_out: rt.closedOut + live_out, streams: rt.sockets.size };
  }

  private stateOf(rt: Runtime): StateReport {
    if (!rt.active) return reportFor("down");
    if (rt.localError) return reportFor("failed", rt.localError);
    if (rt.failure) return reportFor(rt.failure.state, rt.failure.detail);
    const pool = rt.entry?.pool.state;
    if (!pool) return reportFor("ready");
    let state: TunnelState = pool.state;
    // A reverse tunnel is only active once the runner has bound its port.
    if (isReverse(rt.cfg) && state === "active" && rt.reverseId === undefined) state = "connecting";
    return reportFor(state, pool.detail);
  }

  private view(rt: Runtime): TunnelView {
    const cfg = rt.cfg;
    const base = {
      name: cfg.name,
      org: cfg.org,
      server: cfg.server,
      server_id: cfg.server_id,
      kind: cfg.kind,
      keep_up: cfg.keep_up,
      enabled: cfg.enabled,
      ...this.stateOf(rt),
      traffic: this.traffic(rt),
    };
    if (isReverse(cfg)) {
      return { ...base, remote_port: cfg.remote_port, local_target: cfg.local_target, bind_public: cfg.bind_public };
    }
    return { ...base, target: cfg.target, local_port: cfg.local_port, endpoint: `127.0.0.1:${cfg.local_port}` };
  }

  private emitTunnel(rt: Runtime): void {
    if (this.stopping) return;
    this.emit({ type: "tunnel", name: rt.cfg.name, tunnel: this.view(rt) });
  }
}
