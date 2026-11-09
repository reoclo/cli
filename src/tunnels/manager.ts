// src/tunnels/manager.ts
//
// Owns the local side of every saved tunnel: the listener for each enabled
// forward tunnel, the keep-up hold and reverse listener for the others. It
// routes accepted sockets and datagrams into the right server pool, derives
// each tunnel's state, persists desired state, and emits events.

import { randomBytes } from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";
import type tls from "node:tls";
import type { CaStatus, CertSource } from "./ca";
import {
  ConfigError,
  hostnameOf,
  isForward,
  isHttps,
  isReverse,
  loadConfig,
  parseTunnel,
  updateConfig,
  viaOf,
  type ForwardTunnel,
  type HttpsTunnel,
  type SavedTunnel,
  type TunnelsFile,
  type Via,
} from "./config";
import { realRunner } from "./command-runner";
import { HostsError, type HelperStatus, type HostsSink } from "./hosts-client";
import { sharesFile, tunnelsFile } from "./paths";
import { ShareSupervisor, type ShareSpawner, type ShareStatus } from "./shares";
import {
  Tailscale,
  firstIpv4,
  matchPeer,
  portBindProblem,
  statusView,
  targetProblem,
  type ScannedPort,
  type TailscaleStatusView,
} from "./tailscale";
import { dirname, join } from "node:path";
import { TlsProxy } from "./tls-proxy";
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
  hostname?: string;
  /** https tunnels: where a browser opens the tunnel. */
  url?: string;
  target?: string;
  local_port?: number;
  remote_port?: number;
  local_target?: string;
  bind_public?: boolean;
  /** An agent's tunnel: never saved, ends at `expires_at`. */
  adhoc?: boolean;
  expires_at?: string;
  traffic: TunnelTraffic;
  via: Via;
  /** The path the next connection takes. `auto` tunnels switch between the two. */
  path: "relay" | "tailscale";
  /** Why an `auto` tunnel uses the relay, or what stops a `tailscale` tunnel. */
  path_reason?: string;
  /** The server's tailnet peer, once the daemon has looked for it. */
  peer?: { name: string; address?: string; online: boolean };
  share?: ShareView;
}

export interface ShareView {
  tailnet: true;
  port: number;
  state: ShareStatus["state"] | "down";
  /** Where other devices on the tailnet reach the share. */
  url?: string;
  error?: string;
  restarts: number;
}

export type ManagerEvent =
  | { type: "tunnel"; name: string; removed?: boolean; tunnel?: TunnelView }
  | { type: "log"; line: string };

export class ManagerError extends Error {
  constructor(
    readonly code: "invalid" | "not_found" | "conflict" | "unauthorized" | "forbidden" | "upstream",
    message: string,
    /** The tunnel state a failed connection maps onto, when there is one. */
    readonly state?: string,
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
  /** Certificates for the TLS proxy. Without it every HTTPS handshake fails. */
  certs?: CertSource;
  /** The root hosts helper. Without it no hosts entries are written. */
  hosts?: HostsSink;
  now?: () => number;
  /** Longest wait for a session to open when a caller asks to verify the connection. Default 30 s. */
  connectTimeoutMs?: number;
  tailscale?: Tailscale;
  /** Starts the `tailscale serve` child of a share. */
  spawnShare?: ShareSpawner;
  /** Where the pids of share children are recorded. Default: next to the config file. */
  sharesFile?: string;
  /** The server's stored port scan, for the tailnet bind check. A failure counts as no scan. */
  portScan?: (cfg: SavedTunnel) => Promise<ScannedPort[] | undefined>;
  /** Longest wait for a dial over the tailnet. Default 5 s. */
  tailnetConnectTimeoutMs?: number;
}

/** A UDP peer with no datagrams for this long loses its tailnet socket, as on the relay. */
const UDP_IDLE_MS = 60_000;
const SCAN_TTL_MS = 5 * 60_000;

export const DEFAULT_ADHOC_TTL_MINUTES = 60;
export const MAX_ADHOC_TTL_MINUTES = 480;

export interface AdHocInput {
  org: string;
  tenant_id: string;
  profile?: string;
  server: string;
  server_id: string;
  target: string;
  kind: "tcp" | "udp";
  ttl_minutes: number;
}

export interface HostsStatusView {
  installed: boolean;
  version?: string;
  /** Entries in the helper's block when it is installed, else how many it would write. */
  entries: number;
  suffixes: string[];
  relay: { enabled: boolean; listening: boolean; port?: number; error?: string };
  error?: string;
}

export interface HostEntryView {
  hostname: string;
  /** The tunnel that owns the name, or "manual". */
  source: string;
}

export interface SettingsView {
  idle_timeout_seconds: number;
  https_port: number;
  agent_approvals: "required" | "off";
  ca_suffixes: string[];
  manual_hosts: string[];
}

const SETTING_KEYS = ["idle_timeout_seconds", "https_port", "agent_approvals", "ca_suffixes", "manual_hosts"] as const;

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
  adhoc?: { expiresAt: number; ttlTimer?: unknown };
  path: "relay" | "tailscale";
  pathReason?: string;
  peer?: TunnelView["peer"];
  /** `via: tailscale`: why connections are refused. */
  tailnetProblem?: string;
  tailnetPeers: Set<net.Socket>;
  udpAssoc: Map<string, UdpAssoc>;
  /** https shares: the plaintext loopback listener `tailscale serve` forwards to. */
  shareListener?: net.Server;
  shareError?: string;
}

interface UdpAssoc {
  ready: Promise<UdpRoute>;
  sock?: dgram.Socket;
  timer?: unknown;
}

type UdpRoute = { kind: "tailnet"; sock: dgram.Socket; address: string; port: number } | { kind: "relay" } | { kind: "drop" };

type Decision = { path: "tailscale"; address: string } | { path: "relay" };

type TailnetRoute =
  | { ok: true; address: string; peer: NonNullable<TunnelView["peer"]> }
  | { ok: false; reason: string; peer?: NonNullable<TunnelView["peer"]> };

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
  private readonly routes = new Map<string, Runtime>();
  private proxy?: TlsProxy;
  private proxyStarting?: Promise<void>;
  private proxyError?: string;
  private helper: { installed: boolean; status?: HelperStatus; error?: string } = { installed: false };
  private hostsQueue: Promise<void> = Promise.resolve();
  private readonly tailscale: Tailscale;
  private readonly shares: ShareSupervisor;
  private readonly scans = new Map<string, { at: number; ports: ScannedPort[] | undefined }>();

  constructor(private readonly opts: ManagerOptions) {
    this.timers = opts.timers ?? realTimers;
    this.file = loadConfig(this.path);
    this.tailscale = opts.tailscale ?? new Tailscale({ now: opts.now });
    this.shares = new ShareSupervisor({
      tailscale: this.tailscale,
      spawn: opts.spawnShare,
      pidFile: opts.sharesFile ?? (opts.configPath ? join(dirname(opts.configPath), "run", "shares.json") : sharesFile()),
      timers: this.timers,
      log: (line) => this.log(line),
      runner: realRunner,
      onChange: (name) => {
        const rt = this.runtimes.get(name);
        if (rt) this.emitTunnel(rt);
      },
    });
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
    await this.shares.cleanupStale().catch((err: unknown) => this.log(`could not stop old shares: ${err instanceof Error ? err.message : String(err)}`));
    for (const cfg of this.file.tunnels) this.runtimes.set(cfg.name, this.newRuntime(cfg));
    for (const rt of this.runtimes.values()) {
      if (rt.cfg.enabled) await this.activate(rt);
    }
    void this.syncHosts();
  }

  /** Tear everything down without touching the saved desired state. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const rt of this.runtimes.values()) await this.deactivate(rt);
    await this.shares.stopAll();
    for (const entry of [...this.pools.values()]) await this.disposePool(entry);
    await this.hostsQueue;
    await this.proxy?.stop();
    this.proxy = undefined;
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
    await this.fillShare(raw);
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
    void this.syncHosts();
    return this.view(rt);
  }

  async edit(name: string, patch: unknown): Promise<TunnelView> {
    const rt = this.require(name);
    if (rt.adhoc) throw new ManagerError("invalid", `"${name}" is an ad-hoc tunnel and cannot be edited; close it and open another`);
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
      throw new ManagerError("invalid", "the change must be an object");
    }
    const changes = patch as Record<string, unknown>;
    if ("name" in changes && changes["name"] !== name) throw new ManagerError("invalid", "a tunnel cannot be renamed; remove it and add it again");
    if ("kind" in changes && changes["kind"] !== rt.cfg.kind) throw new ManagerError("invalid", "a tunnel cannot change kind; remove it and add it again");
    const merged: Record<string, unknown> = { ...rt.cfg, ...changes, name, kind: rt.cfg.kind };
    for (const [key, value] of Object.entries(merged)) if (value === null) delete merged[key];
    await this.fillShare(merged, rt.cfg);
    const cfg = this.parse(merged);
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
    void this.syncHosts();
    return this.view(rt);
  }

  async remove(name: string): Promise<void> {
    const rt = this.require(name);
    if (rt.adhoc) {
      await this.endAdHoc(rt);
      return;
    }
    await this.deactivate(rt);
    await this.save((file) => {
      file.tunnels = file.tunnels.filter((t) => t.name !== name);
    });
    this.runtimes.delete(name);
    this.emit({ type: "tunnel", name, removed: true });
    void this.syncHosts();
  }

  async up(name: string, o: { verify?: boolean } = {}): Promise<TunnelView> {
    const rt = this.require(name);
    if (!rt.cfg.enabled) {
      rt.cfg = { ...rt.cfg, enabled: true };
      await this.save((file) => this.replace(file, rt.cfg));
    }
    // Any `up` on a server's tunnels clears an expired or operator-closed state for the whole pool.
    rt.localError = undefined;
    rt.failure = undefined;
    await this.activate(rt, { reset: true });
    if (o.verify) await this.verify(rt);
    return this.view(rt);
  }

  async down(name: string): Promise<TunnelView> {
    const rt = this.require(name);
    if (rt.adhoc) return this.endAdHoc(rt);
    if (rt.cfg.enabled) {
      rt.cfg = { ...rt.cfg, enabled: false };
      await this.save((file) => this.replace(file, rt.cfg));
    }
    await this.deactivate(rt);
    return this.view(rt);
  }

  // ── sharing onto the tailnet ─────────────────────────────────────────────

  /** Publish a tcp or https tunnel to the tailnet. It restarts the tunnel, so open connections end. */
  async share(name: string, input: unknown): Promise<TunnelView> {
    const rt = this.require(name);
    if (rt.adhoc) throw new ManagerError("invalid", `"${name}" is an ad-hoc tunnel and cannot be shared`);
    const body = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    if (body["tailnet"] !== true) {
      throw new ManagerError("invalid", "tailnet: true is required; a tailnet is the only place a tunnel can be shared");
    }
    if (rt.cfg.kind !== "tcp" && rt.cfg.kind !== "https") {
      throw new ManagerError("invalid", `only tcp and https tunnels can be shared; "${name}" is ${rt.cfg.kind}`);
    }
    const port = body["port"];
    if (port !== undefined && typeof port !== "number") throw new ManagerError("invalid", "port must be a number");
    return this.edit(name, { share: { tailnet: true, ...(port === undefined ? {} : { port }) } });
  }

  async unshare(name: string): Promise<TunnelView> {
    const rt = this.require(name);
    if (rt.cfg.kind === "reverse" || rt.cfg.share === undefined) return this.view(rt);
    return this.edit(name, { share: null });
  }

  /** Fill in what a share leaves out: the tailnet port, and for https the fixed internal port. */
  private async fillShare(raw: Record<string, unknown>, current?: SavedTunnel): Promise<void> {
    const patch = raw["share"];
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return;
    const before = current && current.kind !== "reverse" ? current.share : undefined;
    const share: Record<string, unknown> = { ...before, ...(patch as Record<string, unknown>) };
    if (share["port"] === undefined) {
      const target = typeof raw["target"] === "string" ? raw["target"] : "";
      if (raw["kind"] === "https") share["port"] = 443;
      else if (/:\d+$/.test(target)) share["port"] = splitHostPort(target).port;
    }
    if (raw["kind"] === "https" && share["internal_port"] === undefined) {
      const name = typeof raw["name"] === "string" ? raw["name"] : undefined;
      share["internal_port"] = await (this.opts.pickPort ?? pickLocalPort)(0, this.usedPorts(name));
    }
    raw["share"] = share;
  }

  private async startShare(rt: Runtime, cfg: ForwardTunnel | HttpsTunnel): Promise<void> {
    const share = cfg.share;
    rt.shareError = undefined;
    if (!share || rt.localError) return;
    let upstream: number;
    if (isHttps(cfg)) {
      const internal = share.internal_port;
      if (internal === undefined) return;
      const target = splitHostPort(cfg.target);
      try {
        const server = net.createServer((sock) => this.onAccept(rt, sock, { remoteHost: target.host, remotePort: target.port }));
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(internal, "127.0.0.1", () => resolve());
        });
        server.on("error", (err) => this.log(`tunnel ${cfg.name}: share listener error: ${err.message}`));
        rt.shareListener = server;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        rt.shareError = e.code === "EADDRINUSE" ? `the share's internal port ${internal} is already in use` : `could not listen on 127.0.0.1:${internal}: ${e.message}`;
        this.log(`tunnel ${cfg.name}: ${rt.shareError}`);
        return;
      }
      upstream = internal;
    } else {
      upstream = cfg.local_port;
    }
    await this.shares.start({ name: cfg.name, kind: isHttps(cfg) ? "https" : "tcp", port: share.port, upstream });
  }

  // ── ad-hoc tunnels and connection checks ─────────────────────────────────

  /**
   * Open a forward tunnel for an agent: a free loopback port, no hostname, never
   * written to tunnels.yaml, closed after its time to live. The session opens
   * before this returns, so sign-in, permission and offline failures reach the
   * caller; on failure the tunnel is not kept.
   */
  async openAdHoc(input: AdHocInput): Promise<TunnelView> {
    const ttl = input.ttl_minutes;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_ADHOC_TTL_MINUTES) {
      throw new ManagerError("invalid", `ttl_minutes must be a whole number from 1 to ${MAX_ADHOC_TTL_MINUTES}`);
    }
    if (input.kind !== "tcp" && input.kind !== "udp") {
      throw new ManagerError("invalid", "an ad-hoc tunnel is tcp or udp");
    }
    const name = this.adHocName();
    const local_port = await (this.opts.pickPort ?? pickLocalPort)(0, this.usedPorts());
    const cfg = this.parse({
      name,
      org: input.org,
      tenant_id: input.tenant_id,
      ...(input.profile === undefined ? {} : { profile: input.profile }),
      server: input.server,
      server_id: input.server_id,
      kind: input.kind,
      target: input.target,
      local_port,
      keep_up: false,
      enabled: true,
    });
    const ms = ttl * 60_000;
    const rt = this.newRuntime(cfg);
    rt.adhoc = { expiresAt: this.now() + ms };
    this.runtimes.set(name, rt);
    await this.activate(rt);
    if (rt.localError) {
      const message = rt.localError;
      await this.endAdHoc(rt);
      throw new ManagerError("conflict", message);
    }
    rt.adhoc.ttlTimer = this.timers.set(() => {
      void this.endAdHoc(rt);
    }, ms);
    try {
      await this.verify(rt);
    } catch (err) {
      await this.endAdHoc(rt);
      throw err;
    }
    return this.view(rt);
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private adHocName(): string {
    for (;;) {
      const name = `adhoc-${randomBytes(3).toString("hex")}`;
      if (!this.runtimes.has(name)) return name;
    }
  }

  private async endAdHoc(rt: Runtime): Promise<TunnelView> {
    await this.deactivate(rt);
    const view = this.view(rt);
    if (this.runtimes.get(rt.cfg.name) === rt) {
      this.runtimes.delete(rt.cfg.name);
      this.emit({ type: "tunnel", name: rt.cfg.name, removed: true });
    }
    return view;
  }

  /** Open the tunnel's session and release it, so a failure reaches the caller instead of the first connection. */
  private async verify(rt: Runtime): Promise<void> {
    const pool = rt.entry?.pool;
    if (!pool) return;
    const connect = pool.acquire("stream");
    const ms = this.opts.connectTimeoutMs ?? 30_000;
    let timer: unknown;
    const timeout = new Promise<never>((_, reject) => {
      timer = this.timers.set(
        () => reject(new ManagerError("upstream", `the session did not open within ${Math.round(ms / 1000)}s`, "connecting")),
        ms,
      );
    });
    try {
      (await Promise.race([connect, timeout])).release();
    } catch (err) {
      // An acquire that finishes after the wait gave up must still give its lease back.
      connect.then(
        (lease) => lease.release(),
        () => undefined,
      );
      throw this.connectError(err);
    } finally {
      this.timers.clear(timer);
    }
  }

  private connectError(err: unknown): ManagerError {
    if (err instanceof ManagerError) return err;
    if (err instanceof PoolError) {
      const code = err.state === "needs_sign_in" ? "unauthorized" : err.state === "forbidden" ? "forbidden" : "upstream";
      return new ManagerError(code, err.message, err.state);
    }
    return new ManagerError("upstream", err instanceof Error ? err.message : String(err), "failed");
  }

  // ── lifecycle of one tunnel ──────────────────────────────────────────────

  private async activate(rt: Runtime, o: { reset?: boolean } = {}): Promise<void> {
    rt.active = true;
    const cfg = rt.cfg;
    const entry = viaOf(cfg) === "tailscale" ? undefined : this.ensurePool(rt);
    if (o.reset) entry?.pool.reset();
    if (isForward(cfg)) await this.bind(rt, cfg);
    else if (isHttps(cfg)) await this.bindHttps(rt, cfg);
    if (cfg.kind !== "reverse" && cfg.share) await this.startShare(rt, cfg);
    if (isReverse(cfg) || cfg.keep_up) void this.connectHeld(rt);
    if (viaOf(cfg) !== "reoclo") void this.refreshPath(rt);
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
    if (rt.adhoc?.ttlTimer !== undefined) {
      this.timers.clear(rt.adhoc.ttlTimer);
      rt.adhoc.ttlTimer = undefined;
    }
    await this.shares.stop(rt.cfg.name);
    rt.shareError = undefined;
    rt.tailnetProblem = undefined;
    for (const sock of [...rt.sockets]) sock.destroy();
    for (const peer of [...rt.tailnetPeers]) peer.destroy();
    for (const key of [...rt.udpAssoc.keys()]) this.closeAssoc(rt, key);
    const shareListener = rt.shareListener;
    rt.shareListener = undefined;
    if (shareListener) await new Promise<void>((r) => shareListener.close(() => r()));
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
    const host = hostnameOf(rt.cfg);
    if (host !== undefined && this.routes.get(host) === rt) {
      this.routes.delete(host);
      if (this.routes.size === 0) await this.stopProxy();
    }
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

  private async bindHttps(rt: Runtime, cfg: HttpsTunnel): Promise<void> {
    this.routes.set(cfg.hostname, rt);
    await this.ensureProxy();
  }

  private ensureProxy(): Promise<void> {
    if (this.proxy?.listening) return Promise.resolve();
    this.proxyStarting ??= this.startProxy().finally(() => {
      this.proxyStarting = undefined;
    });
    return this.proxyStarting;
  }

  private async startProxy(): Promise<void> {
    const proxy = new TlsProxy({
      port: this.file.https_port,
      contextFor: (hostname) => this.contextFor(hostname),
      onConnection: (hostname, sock) => this.onSecure(hostname, sock),
      log: (line) => this.log(line),
    });
    try {
      await proxy.start();
      this.proxy = proxy;
      this.proxyError = undefined;
    } catch (err) {
      this.proxyError = err instanceof Error ? err.message : String(err);
      this.log(`https: ${this.proxyError}`);
    }
    for (const rt of this.routes.values()) this.emitTunnel(rt);
  }

  private async stopProxy(): Promise<void> {
    const proxy = this.proxy;
    this.proxy = undefined;
    this.proxyError = undefined;
    await proxy?.stop();
  }

  private contextFor(hostname: string): Promise<tls.SecureContext> {
    if (!this.routes.get(hostname)?.active) return Promise.reject(new Error(`no active tunnel answers at ${hostname}`));
    if (!this.opts.certs) return Promise.reject(new Error("TLS certificates are not configured"));
    return this.opts.certs.secureContext(hostname);
  }

  private onSecure(hostname: string, sock: tls.TLSSocket): void {
    const rt = this.routes.get(hostname);
    if (!rt || !rt.active || !isHttps(rt.cfg)) {
      sock.destroy();
      return;
    }
    const target = splitHostPort(rt.cfg.target);
    this.onAccept(rt, sock, { remoteHost: target.host, remotePort: target.port });
  }

  private onAccept(
    rt: Runtime,
    sock: net.Socket,
    remote: { remoteHost: string; remotePort: number },
  ): void {
    sock.on("error", () => sock.destroy());
    // Hold the bytes until the session is open: send() drops frames before that.
    sock.pause();
    rt.sockets.add(sock);
    sock.once("close", () => {
      rt.sockets.delete(sock);
      rt.closedIn += sock.bytesWritten;
      rt.closedOut += sock.bytesRead;
    });
    if (!rt.entry && viaOf(rt.cfg) !== "tailscale") {
      sock.destroy();
      return;
    }
    void this.route(rt, sock, remote);
  }

  /** Send one accepted connection over the tailnet or the relay, as the tunnel's `via` says. */
  private async route(rt: Runtime, sock: net.Socket, remote: { remoteHost: string; remotePort: number }): Promise<void> {
    const via = viaOf(rt.cfg);
    if (via !== "reoclo") {
      const decision = await this.decide(rt, remote.remoteHost, remote.remotePort);
      if (sock.destroyed) return;
      if (decision.path === "tailscale") {
        try {
          await this.pipeTailnet(rt, sock, decision.address, remote.remotePort);
          return;
        } catch (err) {
          const reason = `could not dial ${decision.address}:${remote.remotePort} over the tailnet: ${err instanceof Error ? err.message : String(err)}`;
          this.log(`tunnel ${rt.cfg.name}: ${reason}`);
          if (via === "tailscale") {
            this.setPath(rt, { path: "tailscale", peer: rt.peer, problem: reason });
            sock.destroy();
            return;
          }
          this.setPath(rt, { path: "relay", reason, peer: rt.peer });
        }
      } else if (via === "tailscale") {
        this.log(`tunnel ${rt.cfg.name}: connection refused: ${rt.tailnetProblem ?? "the tailnet path is not available"}`);
        sock.destroy();
        return;
      }
    }
    this.relay(rt, sock, remote);
  }

  private relay(rt: Runtime, sock: net.Socket, remote: { remoteHost: string; remotePort: number }): void {
    const pool = rt.entry?.pool;
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

  // ── the tailnet path ─────────────────────────────────────────────────────

  private tailnetStreams(rt: Runtime): number {
    return rt.tailnetPeers.size + [...rt.udpAssoc.values()].filter((a) => a.sock !== undefined).length;
  }

  /** Where a server's port scan says the port listens, cached for five minutes. */
  private async scan(cfg: SavedTunnel): Promise<ScannedPort[] | undefined> {
    const fn = this.opts.portScan;
    if (!fn) return undefined;
    const key = [cfg.profile ?? "", cfg.org, cfg.server_id].join("\u0000");
    const hit = this.scans.get(key);
    if (hit && this.now() - hit.at < SCAN_TTL_MS) return hit.ports;
    let ports: ScannedPort[] | undefined;
    try {
      ports = await fn(cfg);
    } catch (err) {
      this.log(`tunnel ${cfg.name}: no port scan for ${cfg.server}: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.scans.set(key, { at: this.now(), ports });
    return ports;
  }

  private async tailnetRoute(rt: Runtime, host: string, port: number): Promise<TailnetRoute> {
    const cfg = rt.cfg;
    if (cfg.kind === "reverse") return { ok: false, reason: "a reverse tunnel can only use the relay" };
    const proto = cfg.kind === "udp" ? "udp" : "tcp";
    const ineligible = targetProblem(proto, `${host}:${port}`);
    if (ineligible) return { ok: false, reason: ineligible };
    const info = await this.tailscale.status();
    if (!info.installed) return { ok: false, reason: "Tailscale is not installed on this machine" };
    if (!info.running) {
      return { ok: false, reason: `Tailscale is not running (${info.backend_state ?? info.error ?? "state unknown"})` };
    }
    const wanted = cfg.tailnet_host ?? cfg.server_hostname;
    if (wanted === undefined) {
      return { ok: false, reason: "this tunnel has no server hostname to look for on the tailnet; set tailnet_host to the server's name on the tailnet" };
    }
    const peer = matchPeer(info, wanted);
    if (!peer) return { ok: false, reason: `no tailnet peer is named "${wanted}"; set tailnet_host to the server's name on the tailnet` };
    const address = firstIpv4(peer.addresses);
    const view = { name: peer.host_name || wanted, ...(address ? { address } : {}), online: peer.online };
    if (!peer.online) return { ok: false, reason: `${view.name} is offline on the tailnet`, peer: view };
    if (!address) return { ok: false, reason: `${view.name} has no IPv4 address on the tailnet`, peer: view };
    const bind = portBindProblem(await this.scan(cfg), port, proto);
    if (bind) return { ok: false, reason: bind, peer: view };
    return { ok: true, address, peer: view };
  }

  /** Decide the path for a target and record it on the tunnel. `via: tailscale` never falls back. */
  private async decide(rt: Runtime, host: string, port: number): Promise<Decision> {
    const route = await this.tailnetRoute(rt, host, port);
    if (route.ok) {
      this.setPath(rt, { path: "tailscale", peer: route.peer });
      return { path: "tailscale", address: route.address };
    }
    if (viaOf(rt.cfg) === "tailscale") this.setPath(rt, { path: "tailscale", peer: route.peer, problem: route.reason });
    else this.setPath(rt, { path: "relay", reason: route.reason, peer: route.peer });
    return { path: "relay" };
  }

  private setPath(rt: Runtime, next: { path: "relay" | "tailscale"; reason?: string; peer?: TunnelView["peer"]; problem?: string }): void {
    const same =
      rt.path === next.path &&
      rt.pathReason === next.reason &&
      rt.tailnetProblem === next.problem &&
      JSON.stringify(rt.peer) === JSON.stringify(next.peer);
    rt.path = next.path;
    rt.pathReason = next.reason;
    rt.peer = next.peer;
    rt.tailnetProblem = next.problem;
    if (!same) this.emitTunnel(rt);
  }

  /** Look at the tailnet once the tunnel is up, so status shows the peer and any problem before the first connection. */
  private async refreshPath(rt: Runtime): Promise<void> {
    const cfg = rt.cfg;
    if (cfg.kind === "reverse") return;
    const target = splitHostPort(cfg.target);
    await this.decide(rt, target.host, target.port);
  }

  private pipeTailnet(rt: Runtime, sock: net.Socket, address: string, port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const peer = net.connect({ host: address, port });
      const ms = this.opts.tailnetConnectTimeoutMs ?? 5000;
      const timer = this.timers.set(() => peer.destroy(new Error(`no answer within ${Math.round(ms / 1000)}s`)), ms);
      peer.once("error", (err) => {
        this.timers.clear(timer);
        peer.destroy();
        reject(err);
      });
      peer.once("connect", () => {
        this.timers.clear(timer);
        peer.removeAllListeners("error");
        if (sock.destroyed) {
          peer.destroy();
          resolve();
          return;
        }
        this.log(`tunnel ${rt.cfg.name}: connection over the tailnet to ${address}:${port}`);
        peer.on("error", () => peer.destroy());
        rt.tailnetPeers.add(peer);
        peer.once("close", () => {
          rt.tailnetPeers.delete(peer);
          sock.destroy();
          this.emitTunnel(rt);
        });
        sock.once("close", () => peer.destroy());
        sock.pipe(peer);
        peer.pipe(sock);
        sock.resume();
        this.emitTunnel(rt);
        resolve();
      });
    });
  }

  private onDatagram(
    rt: Runtime,
    listener: dgram.Socket,
    buf: Buffer,
    rinfo: dgram.RemoteInfo,
    remote: { remoteHost: string; remotePort: number },
  ): void {
    if (viaOf(rt.cfg) === "reoclo") {
      this.relayDatagram(rt, listener, buf, rinfo, remote);
      return;
    }
    const key = `${rinfo.address}:${rinfo.port}`;
    let assoc = rt.udpAssoc.get(key);
    if (!assoc) {
      const ready = this.udpRoute(rt, key, listener, rinfo, remote);
      assoc = { ready };
      rt.udpAssoc.set(key, assoc);
    }
    const mine = assoc;
    void mine.ready.then((route) => {
      if (route.kind === "relay") {
        this.relayDatagram(rt, listener, buf, rinfo, remote);
      } else if (route.kind === "tailnet" && rt.udpAssoc.get(key) === mine) {
        rt.closedOut += buf.length;
        this.armAssocIdle(rt, key);
        route.sock.send(buf, route.port, route.address);
      }
    });
  }

  /** One tailnet socket per local peer. A peer that cannot use the tailnet is forgotten, so its next datagram decides again. */
  private async udpRoute(
    rt: Runtime,
    key: string,
    listener: dgram.Socket,
    rinfo: dgram.RemoteInfo,
    remote: { remoteHost: string; remotePort: number },
  ): Promise<UdpRoute> {
    const decision = await this.decide(rt, remote.remoteHost, remote.remotePort);
    const assoc = rt.udpAssoc.get(key);
    if (decision.path !== "tailscale" || !assoc || !rt.active) {
      rt.udpAssoc.delete(key);
      return { kind: viaOf(rt.cfg) === "tailscale" ? "drop" : "relay" };
    }
    const sock = dgram.createSocket(decision.address.includes(":") ? "udp6" : "udp4");
    sock.on("error", (err) => this.log(`tunnel ${rt.cfg.name}: tailnet socket error: ${err.message}`));
    sock.on("message", (msg) => {
      rt.closedIn += msg.length;
      this.armAssocIdle(rt, key);
      listener.send(msg, rinfo.port, rinfo.address);
    });
    assoc.sock = sock;
    this.log(`tunnel ${rt.cfg.name}: datagrams from ${key} go over the tailnet to ${decision.address}:${remote.remotePort}`);
    this.armAssocIdle(rt, key);
    this.emitTunnel(rt);
    return { kind: "tailnet", sock, address: decision.address, port: remote.remotePort };
  }

  private armAssocIdle(rt: Runtime, key: string): void {
    const assoc = rt.udpAssoc.get(key);
    if (!assoc) return;
    if (assoc.timer !== undefined) this.timers.clear(assoc.timer);
    assoc.timer = this.timers.set(() => {
      this.closeAssoc(rt, key);
      this.emitTunnel(rt);
    }, UDP_IDLE_MS);
  }

  private closeAssoc(rt: Runtime, key: string): void {
    const assoc = rt.udpAssoc.get(key);
    if (!assoc) return;
    rt.udpAssoc.delete(key);
    if (assoc.timer !== undefined) this.timers.clear(assoc.timer);
    assoc.sock?.close();
  }

  private relayDatagram(
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
    return {
      cfg,
      active: false,
      sockets: new Set(),
      closedIn: 0,
      closedOut: 0,
      connecting: false,
      attempt: 0,
      path: viaOf(cfg) === "tailscale" ? "tailscale" : "relay",
      tailnetPeers: new Set(),
      udpAssoc: new Map(),
    };
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
      if (isForward(cfg) && used.has(cfg.local_port)) {
        throw new ManagerError("conflict", `local port ${cfg.local_port} is already used by another saved tunnel`);
      }
      if (isHttps(cfg) && cfg.share?.internal_port !== undefined && used.has(cfg.share.internal_port)) {
        throw new ManagerError("conflict", `the share's internal port ${cfg.share.internal_port} is already used by another saved tunnel`);
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
      if (rt.cfg.name === except) continue;
      if (isForward(rt.cfg)) used.add(rt.cfg.local_port);
      if (isHttps(rt.cfg) && rt.cfg.share?.internal_port !== undefined) used.add(rt.cfg.share.internal_port);
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
    if (isHttps(rt.cfg) && this.proxyError) return reportFor("failed", this.proxyError);
    if (rt.failure) return reportFor(rt.failure.state, rt.failure.detail);
    if (viaOf(rt.cfg) === "tailscale") {
      if (rt.tailnetProblem) return reportFor("failed", rt.tailnetProblem);
      return reportFor(this.tailnetStreams(rt) > 0 ? "active" : "ready");
    }
    const pool = rt.entry?.pool.state;
    if (!pool) return reportFor("ready");
    let state: TunnelState = pool.state;
    if (state === "ready" && this.tailnetStreams(rt) > 0) state = "active";
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
      via: viaOf(cfg),
      path: rt.path,
      ...(rt.pathReason ? { path_reason: rt.pathReason } : {}),
      ...(rt.peer ? { peer: rt.peer } : {}),
      ...this.shareView(rt),
      ...this.stateOf(rt),
      ...(rt.adhoc ? { adhoc: true, expires_at: new Date(rt.adhoc.expiresAt).toISOString() } : {}),
      traffic: this.traffic(rt),
    };
    if (isReverse(cfg)) {
      return { ...base, remote_port: cfg.remote_port, local_target: cfg.local_target, bind_public: cfg.bind_public };
    }
    if (isHttps(cfg)) return { ...base, target: cfg.target, hostname: cfg.hostname, url: this.urlFor(cfg.hostname) };
    return {
      ...base,
      target: cfg.target,
      local_port: cfg.local_port,
      endpoint: `127.0.0.1:${cfg.local_port}`,
      ...(cfg.hostname ? { hostname: cfg.hostname } : {}),
    };
  }

  /** The port is dropped from the URL once the helper relays 443 to the proxy. */
  private urlFor(hostname: string): string {
    const relay = this.helper.status?.relay;
    const relayed = relay?.enabled === true && relay.listening && relay.port === this.file.https_port;
    return `https://${hostname}${relayed ? "" : `:${this.file.https_port}`}`;
  }

  // ── settings, hosts and certificates ─────────────────────────────────────

  settings(): SettingsView {
    const f = this.file;
    return {
      idle_timeout_seconds: f.idle_timeout_seconds,
      https_port: f.https_port,
      agent_approvals: f.agent_approvals,
      ca_suffixes: f.ca_suffixes,
      manual_hosts: f.manual_hosts,
    };
  }

  async updateSettings(patch: unknown): Promise<SettingsView> {
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
      throw new ManagerError("invalid", "the settings change must be an object");
    }
    const changes = patch as Record<string, unknown>;
    const unknown = Object.keys(changes).filter((k) => !(SETTING_KEYS as readonly string[]).includes(k));
    if (unknown.length > 0) {
      throw new ManagerError("invalid", `cannot change ${unknown.join(", ")}; settings are ${SETTING_KEYS.join(", ")}`);
    }
    const before = this.file;
    await this.save((file) => Object.assign(file, changes));
    if (JSON.stringify(before.ca_suffixes) !== JSON.stringify(this.file.ca_suffixes)) this.opts.certs?.reload();
    if (before.idle_timeout_seconds !== this.file.idle_timeout_seconds) {
      for (const entry of this.pools.values()) entry.pool.setIdleTimeout?.(this.file.idle_timeout_seconds * 1000);
    }
    if (before.https_port !== this.file.https_port && this.routes.size > 0) {
      await this.stopProxy();
      await this.ensureProxy();
    }
    for (const rt of this.routes.values()) this.emitTunnel(rt);
    void this.syncHosts();
    return this.settings();
  }

  reloadCa(): void {
    this.opts.certs?.reload();
  }

  async caStatus(): Promise<CaStatus> {
    if (!this.opts.certs) return { exists: false, trusted: false, suffixes: [], stale: false };
    return this.opts.certs.status(this.file.ca_suffixes);
  }

  private shareView(rt: Runtime): { share: ShareView } | Record<string, never> {
    const share = rt.cfg.kind === "reverse" ? undefined : rt.cfg.share;
    if (!share) return {};
    const status: ShareStatus | undefined = rt.shareError
      ? { state: "failed", error: rt.shareError, restarts: 0 }
      : this.shares.status(rt.cfg.name);
    return {
      share: {
        tailnet: true,
        port: share.port,
        state: status?.state ?? "down",
        ...(status?.url ? { url: status.url } : {}),
        ...(status?.error ? { error: status.error } : {}),
        restarts: status?.restarts ?? 0,
      },
    };
  }

  async tailscaleStatus(): Promise<TailscaleStatusView> {
    return statusView(await this.tailscale.status());
  }

  httpsStatus(): { port: number; listening: boolean; error?: string } {
    return {
      port: this.file.https_port,
      listening: this.proxy?.listening ?? false,
      ...(this.proxyError ? { error: this.proxyError } : {}),
    };
  }

  /** Every hostname the hosts block carries and who owns it. */
  hostEntries(): HostEntryView[] {
    const out = new Map<string, string>();
    for (const h of this.file.manual_hosts) out.set(h, "manual");
    for (const rt of this.runtimes.values()) {
      const h = hostnameOf(rt.cfg);
      if (h !== undefined) out.set(h, rt.cfg.name);
    }
    return [...out.entries()].map(([hostname, source]) => ({ hostname, source })).sort((a, b) => a.hostname.localeCompare(b.hostname));
  }

  /** Send the full hostname list to the helper. Never throws: a helper problem shows in status and never fails a tunnel. */
  syncHosts(): Promise<HostsStatusView> {
    const run = this.hostsQueue.then(() => this.pushHosts());
    this.hostsQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async pushHosts(): Promise<HostsStatusView> {
    const sink = this.opts.hosts;
    const entries = this.hostEntries().map((e) => e.hostname);
    if (sink && !this.stopping) {
      try {
        this.helper = { installed: true, status: await sink.set(entries) };
      } catch (err) {
        this.helper = this.helperFailure(err);
      }
      for (const rt of this.routes.values()) this.emitTunnel(rt);
    }
    return this.hostsView(entries.length);
  }

  private helperFailure(err: unknown): { installed: boolean; error?: string } {
    if (err instanceof HostsError && err.code === "not_installed") return { installed: false };
    const error = err instanceof Error ? err.message : String(err);
    this.log(`hosts helper: ${error}`);
    return { installed: true, error };
  }

  private hostsView(wanted: number): HostsStatusView {
    const s = this.helper.status;
    return {
      installed: this.helper.installed,
      ...(s ? { version: s.version } : {}),
      entries: s ? s.entries : wanted,
      suffixes: s?.suffixes ?? [],
      relay: s?.relay ?? { enabled: false, listening: false },
      ...(this.helper.error ? { error: this.helper.error } : {}),
    };
  }

  /** The helper's state, asked fresh so the relay shows as it is now. */
  async hostsStatus(): Promise<HostsStatusView> {
    const sink = this.opts.hosts;
    if (sink) {
      try {
        this.helper = { installed: true, status: await sink.status() };
      } catch (err) {
        this.helper = this.helperFailure(err);
      }
    }
    return this.hostsView(this.hostEntries().length);
  }

  private emitTunnel(rt: Runtime): void {
    if (this.stopping) return;
    this.emit({ type: "tunnel", name: rt.cfg.name, tunnel: this.view(rt) });
  }
}
