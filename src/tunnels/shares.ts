// src/tunnels/shares.ts
//
// Runs one foreground `tailscale serve` child per shared tunnel. A share lives
// exactly as long as its tunnel: the daemon stops the child with the tunnel or
// when it exits, and a share that dies on its own restarts with backoff. Child
// pids are written to run/shares.json, so a daemon that crashed cannot leave a
// share pointing at nothing: the next start stops them.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CommandRunner } from "./command-runner";
import type { Timers } from "./pool";
import type { Tailscale } from "./tailscale";

export interface ShareSpec {
  name: string;
  kind: "https" | "tcp";
  /** The port on this machine's tailnet address. */
  port: number;
  /** The loopback port the share forwards to. */
  upstream: number;
}

export type ShareState = "starting" | "active" | "restarting" | "failed";

export interface ShareStatus {
  state: ShareState;
  /** Where other devices on the tailnet reach the share. */
  url?: string;
  /** Why the share is not active. */
  error?: string;
  restarts: number;
}

export interface ShareExit {
  code: number | null;
  signal: string | null;
}

export interface ShareProcess {
  pid?: number;
  onOutput(fn: (chunk: string) => void): void;
  exited: Promise<ShareExit>;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
}

export type ShareSpawner = (bin: string, args: string[]) => ShareProcess;

export const realSpawner: ShareSpawner = (bin, args) => {
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<ShareExit>((resolve) => {
    child.once("error", () => resolve({ code: 127, signal: null }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    pid: child.pid,
    onOutput(fn) {
      child.stdout?.on("data", (b: Buffer) => fn(b.toString()));
      child.stderr?.on("data", (b: Buffer) => fn(b.toString()));
    },
    exited,
    kill(signal = "SIGTERM") {
      child.kill(signal);
    },
  };
};

/** The arguments of the foreground serve command for a share. Never `--bg`. */
export function serveArgs(spec: Pick<ShareSpec, "kind" | "port" | "upstream">): string[] {
  return spec.kind === "https"
    ? ["serve", `--https=${spec.port}`, `http://127.0.0.1:${spec.upstream}`]
    : ["serve", `--tcp=${spec.port}`, `tcp://127.0.0.1:${spec.upstream}`];
}

export const MAX_RESTART_DELAY_MS = 30_000;
const KILL_GRACE_MS = 3000;
const VERIFY_EVERY_MS = 1000;
const VERIFY_ATTEMPTS = 10;

interface Entry {
  spec: ShareSpec;
  status: ShareStatus;
  proc?: ShareProcess;
  tail: string;
  attempt: number;
  stopped: boolean;
  retryTimer?: unknown;
  verifyTimer?: unknown;
}

export interface ShareSupervisorOptions {
  tailscale: Tailscale;
  spawn?: ShareSpawner;
  pidFile: string;
  timers: Timers;
  log: (line: string) => void;
  onChange: (name: string) => void;
  /** Runs `ps` to tell a leftover share from a program that reused its pid. */
  runner?: CommandRunner;
  kill?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
}

function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return lines[lines.length - 1] ?? "";
}

/** A plain reason for a serve command that ended, from what it printed. */
export function explainExit(exit: ShareExit, output: string): string {
  if (/https.*(not enabled|disabled)|enable.*https|certificates?.*(not enabled|disabled)/i.test(output)) {
    return "HTTPS certificates are not enabled for this tailnet; turn them on under DNS in the Tailscale admin console";
  }
  const line = lastLine(output);
  const how = exit.signal ? `was stopped by ${exit.signal}` : `exited with code ${exit.code ?? "?"}`;
  return line === "" ? `tailscale serve ${how}` : `tailscale serve ${how}: ${line}`;
}

export class ShareSupervisor {
  private readonly entries = new Map<string, Entry>();
  private readonly spawnFn: ShareSpawner;

  constructor(private readonly opts: ShareSupervisorOptions) {
    this.spawnFn = opts.spawn ?? realSpawner;
  }

  status(name: string): ShareStatus | undefined {
    const e = this.entries.get(name);
    return e ? { ...e.status } : undefined;
  }

  /** Start sharing, replacing a share of the same name. The share is up once its status says so. */
  async start(spec: ShareSpec): Promise<void> {
    await this.stop(spec.name);
    const entry: Entry = { spec, status: { state: "starting", restarts: 0 }, tail: "", attempt: 0, stopped: false };
    this.entries.set(spec.name, entry);
    this.opts.onChange(spec.name);
    void this.run(entry);
  }

  async stop(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) return;
    this.entries.delete(name);
    entry.stopped = true;
    this.clearTimers(entry);
    const proc = entry.proc;
    entry.proc = undefined;
    if (proc) {
      proc.kill();
      let grace: unknown;
      const gone = await Promise.race([
        proc.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          grace = this.opts.timers.set(() => resolve(false), KILL_GRACE_MS);
        }),
      ]);
      this.opts.timers.clear(grace);
      if (!gone) {
        proc.kill("SIGKILL");
        await proc.exited;
      }
      this.forget(proc.pid);
    }
  }

  async stopAll(): Promise<void> {
    for (const name of [...this.entries.keys()]) await this.stop(name);
  }

  /** Stop the share children a crashed daemon left behind. Returns the pids it stopped. */
  async cleanupStale(): Promise<number[]> {
    let recorded: Array<{ pid: number }> = [];
    try {
      const raw = JSON.parse(readFileSync(this.opts.pidFile, "utf8")) as { shares?: Array<{ pid?: unknown }> };
      recorded = (raw.shares ?? []).filter((s): s is { pid: number } => typeof s.pid === "number" && s.pid > 0);
    } catch {
      return [];
    }
    const stopped: number[] = [];
    for (const { pid } of recorded) {
      if (await this.isShare(pid)) {
        this.killPid(pid, "SIGTERM");
        stopped.push(pid);
        this.opts.log(`stopped tailscale serve child ${pid} left by an earlier daemon`);
      }
    }
    rmSync(this.opts.pidFile, { force: true });
    return stopped;
  }

  private async isShare(pid: number): Promise<boolean> {
    if (!this.opts.runner) return false;
    const res = await this.opts.runner("ps", ["-o", "command=", "-p", String(pid)]);
    const command = res.stdout.trim();
    return res.code === 0 && /tailscale/i.test(command) && /\bserve\b/.test(command);
  }

  private killPid(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
    try {
      (this.opts.kill ?? ((p, s) => process.kill(p, s)))(pid, signal);
    } catch {
      /* already gone */
    }
  }

  private async run(entry: Entry): Promise<void> {
    if (entry.stopped) return;
    const spec = entry.spec;
    const check = await this.preflight(spec);
    if (entry.stopped) return;
    if (!check.ok) return this.retryLater(entry, "failed", check.error);
    const bin = this.opts.tailscale.binary();
    if (bin === undefined) return this.retryLater(entry, "failed", "Tailscale is not installed on this machine");
    entry.tail = "";
    entry.status = { ...entry.status, state: "starting", url: check.url, error: undefined };
    const proc = this.spawnFn(bin, serveArgs(spec));
    entry.proc = proc;
    this.record(proc.pid, spec);
    this.opts.onChange(spec.name);
    proc.onOutput((chunk) => {
      entry.tail = (entry.tail + chunk).slice(-2000);
      if (entry.proc === proc && /available (within your tailnet|on the internet)/i.test(entry.tail)) this.markActive(entry);
    });
    this.scheduleVerify(entry, proc, 0);
    const exit = await proc.exited;
    this.forget(proc.pid);
    if (entry.proc !== proc || entry.stopped) return;
    entry.proc = undefined;
    this.clearTimers(entry);
    const reason = explainExit(exit, entry.tail);
    this.opts.log(`share ${spec.name}: ${reason}`);
    this.retryLater(entry, "restarting", reason);
  }

  private async preflight(spec: ShareSpec): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const info = await this.opts.tailscale.status({ fresh: true });
    if (!info.installed) {
      return { ok: false, error: "Tailscale is not installed on this machine; install it from https://tailscale.com/download" };
    }
    if (!info.running) {
      return { ok: false, error: `Tailscale is not running (${info.backend_state ?? info.error ?? "state unknown"}); start it and the share comes up on its own` };
    }
    if (spec.kind === "https" && !info.https_certificates) {
      return { ok: false, error: "HTTPS certificates are not enabled for this tailnet; turn them on under DNS in the Tailscale admin console" };
    }
    if (info.self_dns_name === undefined) return { ok: false, error: "this machine has no name on the tailnet yet" };
    const taken = (await this.opts.tailscale.served()).find((s) => s.port === spec.port);
    if (taken && !(taken.target ?? "").includes(`127.0.0.1:${spec.upstream}`)) {
      return { ok: false, error: `port ${spec.port} is already served on this machine by tailscale serve${taken.target ? ` (${taken.target})` : ""}; pick another with --port` };
    }
    const url = spec.kind === "https" ? `https://${info.self_dns_name}:${spec.port}` : `tcp://${info.self_dns_name}:${spec.port}`;
    return { ok: true, url };
  }

  private markActive(entry: Entry): void {
    if (entry.status.state === "active" || entry.stopped) return;
    entry.status = { ...entry.status, state: "active", error: undefined };
    entry.attempt = 0;
    this.clearVerify(entry);
    this.opts.log(`share ${entry.spec.name}: ${entry.status.url ?? ""} is up`);
    this.opts.onChange(entry.spec.name);
  }

  private scheduleVerify(entry: Entry, proc: ShareProcess, n: number): void {
    entry.verifyTimer = this.opts.timers.set(() => {
      entry.verifyTimer = undefined;
      void this.verify(entry, proc, n);
    }, VERIFY_EVERY_MS);
  }

  private async verify(entry: Entry, proc: ShareProcess, n: number): Promise<void> {
    if (entry.stopped || entry.proc !== proc || entry.status.state !== "starting") return;
    const served = await this.opts.tailscale.served();
    if (entry.stopped || entry.proc !== proc || entry.status.state !== "starting") return;
    if (served.some((s) => s.port === entry.spec.port)) return this.markActive(entry);
    if (n + 1 < VERIFY_ATTEMPTS) this.scheduleVerify(entry, proc, n + 1);
  }

  private retryLater(entry: Entry, state: "failed" | "restarting", error: string): void {
    const delay = Math.min(MAX_RESTART_DELAY_MS, 1000 * 2 ** entry.attempt);
    entry.attempt++;
    entry.status = { ...entry.status, state, error, restarts: entry.status.restarts + (state === "restarting" ? 1 : 0) };
    this.opts.onChange(entry.spec.name);
    entry.retryTimer = this.opts.timers.set(() => {
      entry.retryTimer = undefined;
      void this.run(entry);
    }, delay);
  }

  private clearVerify(entry: Entry): void {
    if (entry.verifyTimer !== undefined) {
      this.opts.timers.clear(entry.verifyTimer);
      entry.verifyTimer = undefined;
    }
  }

  private clearTimers(entry: Entry): void {
    this.clearVerify(entry);
    if (entry.retryTimer !== undefined) {
      this.opts.timers.clear(entry.retryTimer);
      entry.retryTimer = undefined;
    }
  }

  private pids = new Map<number, string>();

  private record(pid: number | undefined, spec: ShareSpec): void {
    if (pid === undefined) return;
    this.pids.set(pid, spec.name);
    this.writePids();
  }

  private forget(pid: number | undefined): void {
    if (pid === undefined || !this.pids.delete(pid)) return;
    this.writePids();
  }

  private writePids(): void {
    if (this.pids.size === 0) {
      rmSync(this.opts.pidFile, { force: true });
      return;
    }
    mkdirSync(dirname(this.opts.pidFile), { recursive: true, mode: 0o700 });
    const shares = [...this.pids.entries()].map(([pid, name]) => ({ pid, name }));
    writeFileSync(this.opts.pidFile, JSON.stringify({ shares }), { mode: 0o600 });
  }
}
