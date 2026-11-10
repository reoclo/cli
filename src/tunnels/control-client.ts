// src/tunnels/control-client.ts
//
// What the CLI commands use to talk to the daemon over its Unix socket, and
// how they start it when nothing answers.

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ApprovalView } from "./approvals";
import type { CaStatus } from "./ca";
import type { OrgView, PortView, ServerView } from "./directory";
import type { HostEntryView, HostsStatusView, SettingsView, TunnelView } from "./manager";
import { logFile, runDir, socketPath, stateDir } from "./paths";
import type { ForegroundTunnel } from "./foreground";
import type { TailscaleStatusView } from "./tailscale";

export class DaemonError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly state?: string,
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
  signed_in?: boolean;
  tunnels: { total: number; enabled: number; by_state: Record<string, number> };
  https?: { port: number; listening: boolean; error?: string };
  ca?: CaStatus;
  hosts?: HostsStatusView;
  tailscale?: TailscaleStatusView;
}

export interface HostsListing {
  entries: HostEntryView[];
  helper: HostsStatusView;
}

export interface ClientIdentity {
  /** `cli` (default), `app` or `mcp`. The daemon applies agent approvals to `mcp`. */
  client?: string;
  /** The MCP client's name from its initialize handshake. */
  agent?: string;
}

/** A reply that is either the finished action or, with status 202, an approval the action waits on. */
export interface GatedReply<T> {
  status: number;
  body: T | ApprovalView;
}

export class ControlClient {
  constructor(
    private readonly socket: string = socketPath(),
    private readonly identity: ClientIdentity = {},
  ) {}

  private headers(withBody: boolean): Record<string, string> {
    // Header values must be printable ASCII; an agent's name is whatever the MCP client sent.
    const agent = this.identity.agent?.replace(/[^\x20-\x7e]/g, "?").slice(0, 100);
    return {
      "x-reoclo-client": this.identity.client ?? "cli",
      ...(agent ? { "x-reoclo-agent": agent } : {}),
      ...(withBody ? { "content-type": "application/json" } : {}),
    };
  }

  async request<T>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    return (await this.requestWithStatus<T>(method, path, body, timeoutMs)).body;
  }

  async requestWithStatus<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 30_000,
  ): Promise<{ status: number; body: T }> {
    let res: Response;
    try {
      res = await fetch(`http://localhost${path}`, {
        method,
        unix: this.socket,
        headers: this.headers(body !== undefined),
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
      const e = (parsed as { error?: { code?: string; message?: string; state?: string } } | undefined)?.error;
      throw new DaemonError(e?.code ?? "error", e?.message ?? `the daemon answered ${res.status}`, res.status, e?.state);
    }
    return { status: res.status, body: parsed as T };
  }

  status(): Promise<DaemonStatus> {
    return this.request("GET", "/v1/status");
  }
  async tunnels(): Promise<TunnelView[]> {
    return (await this.request<{ tunnels: TunnelView[] }>("GET", "/v1/tunnels")).tunnels;
  }
  /** Tunnels running in terminals. A daemon older than this feature has none to report. */
  async foreground(): Promise<ForegroundTunnel[]> {
    try {
      return (await this.request<{ tunnels: ForegroundTunnel[] }>("GET", "/v1/foreground")).tunnels;
    } catch (err) {
      if (err instanceof DaemonError && err.code === "not_found") return [];
      throw err;
    }
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
  share(name: string, body: { tailnet: true; port?: number }): Promise<TunnelView> {
    return this.request("POST", `/v1/tunnels/${encodeURIComponent(name)}/share`, body, 60_000);
  }
  unshare(name: string): Promise<TunnelView> {
    return this.request("DELETE", `/v1/tunnels/${encodeURIComponent(name)}/share`, undefined, 60_000);
  }
  /** Open ad-hoc tunnels wait for the session, so the request may take up to the daemon's 30 s connect wait. */
  openAdHoc(body: Record<string, unknown>): Promise<TunnelView> {
    return this.request("POST", "/v1/tunnels/open", body, 45_000);
  }
  async approvals(all = false): Promise<ApprovalView[]> {
    return (await this.request<{ approvals: ApprovalView[] }>("GET", `/v1/approvals${all ? "?all=true" : ""}`)).approvals;
  }
  approval(id: string): Promise<ApprovalView> {
    return this.request("GET", `/v1/approvals/${encodeURIComponent(id)}`);
  }
  approve(id: string): Promise<ApprovalView> {
    return this.request("POST", `/v1/approvals/${encodeURIComponent(id)}/approve`, undefined, 60_000);
  }
  deny(id: string): Promise<ApprovalView> {
    return this.request("POST", `/v1/approvals/${encodeURIComponent(id)}/deny`);
  }
  async orgs(): Promise<OrgView[]> {
    return (await this.request<{ orgs: OrgView[] }>("GET", "/v1/orgs")).orgs;
  }
  async servers(org: string): Promise<ServerView[]> {
    return (await this.request<{ servers: ServerView[] }>("GET", `/v1/orgs/${encodeURIComponent(org)}/servers`)).servers;
  }
  async ports(org: string, server: string): Promise<PortView[]> {
    const path = `/v1/orgs/${encodeURIComponent(org)}/servers/${encodeURIComponent(server)}/ports`;
    return (await this.request<{ ports: PortView[] }>("GET", path)).ports;
  }

  /**
   * Wait for an approval to be decided: resolves with the decided approval, or
   * undefined when `signal` aborts first. Subscribes to the event stream before
   * reading the current state, so a decision made in between is not missed.
   */
  async waitForApproval(id: string, signal: AbortSignal): Promise<ApprovalView | undefined> {
    const inner = new AbortController();
    const onAbort = (): void => inner.abort();
    if (signal.aborted) inner.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch("http://localhost/v1/events", { unix: this.socket, headers: this.headers(false), signal: inner.signal });
      if (!res.ok || !res.body) throw new DaemonError("error", `the event stream answered ${res.status}`, res.status);
      const current = await this.approval(id);
      if (current.status !== "pending") return current;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return undefined;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (!block.startsWith("event: approval") || data === undefined) continue;
          const decided = (JSON.parse(data) as { approval?: ApprovalView }).approval;
          if (decided?.id === id && decided.status !== "pending") return decided;
        }
      }
    } catch (err) {
      if (inner.signal.aborted) return undefined;
      throw err;
    } finally {
      signal.removeEventListener("abort", onAbort);
      inner.abort();
    }
  }
  down(name: string): Promise<TunnelView> {
    return this.request("POST", `/v1/tunnels/${encodeURIComponent(name)}/down`);
  }
  async shutdown(): Promise<void> {
    await this.request("POST", "/v1/shutdown");
  }
  settings(): Promise<SettingsView> {
    return this.request("GET", "/v1/settings");
  }
  updateSettings(patch: Partial<SettingsView>): Promise<SettingsView> {
    return this.request("PATCH", "/v1/settings", patch);
  }
  hosts(): Promise<HostsListing> {
    return this.request("GET", "/v1/hosts");
  }
  syncHosts(): Promise<HostsListing> {
    return this.request("POST", "/v1/hosts/sync");
  }
  reloadCa(): Promise<CaStatus> {
    return this.request("POST", "/v1/ca/reload");
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
  // Not the caller's directory: a long-lived caller (`reoclo mcp`) may sit in one that was deleted, and Bun will not start there.
  const child = spawn(cmd, args, { detached: true, cwd: homedir(), stdio: ["ignore", fd, fd], env: process.env });
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
export async function connectToDaemon(opts: { autoStart?: boolean; identity?: ClientIdentity } = {}): Promise<ControlClient> {
  const socket = socketPath();
  if (!(await daemonResponding(socket))) {
    if (opts.autoStart === false) throw new DaemonError("not_running", "the tunnel daemon is not running; start it with: reoclo tunnel daemon start");
    const { exited } = spawnDaemon();
    await waitForDaemon(exited, socket);
  }
  return new ControlClient(socket, opts.identity);
}
