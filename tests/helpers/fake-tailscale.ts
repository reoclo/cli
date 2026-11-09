// tests/helpers/fake-tailscale.ts
//
// Synthetic Tailscale for the tunnel tests: `status --json` and `serve status
// --json` answers in the CLI's real shape with made-up names and addresses, a
// command runner that serves them and records every call, and a fake
// `tailscale serve` child process. Nothing here runs the real CLI.

import type { CommandResult, CommandRunner } from "../../src/tunnels/command-runner";
import type { ShareExit, ShareProcess, ShareSpawner } from "../../src/tunnels/shares";
import { Tailscale } from "../../src/tunnels/tailscale";
import type { ManualTimers } from "./fake-pool";

export const TAILNET = "example-tailnet.ts.net";
export const SELF_DNS = `laptop.${TAILNET}`;

export interface FakePeer {
  host: string;
  dns?: string;
  ips?: string[];
  online?: boolean;
}

export interface StatusOptions {
  state?: string;
  certDomains?: string[] | null;
  peers?: FakePeer[] | null;
}

/** `tailscale status --json` as the CLI prints it, trimmed to the fields the daemon reads. */
export function statusJson(o: StatusOptions = {}): string {
  const state = o.state ?? "Running";
  const peers = o.peers === undefined ? [] : o.peers;
  return JSON.stringify({
    Version: "1.0.0-test",
    BackendState: state,
    TailscaleIPs: state === "Running" ? ["100.64.0.1", "fd7a:115c:a1e0::1"] : null,
    Self: { HostName: "laptop", DNSName: `${SELF_DNS}.`, Online: state === "Running" },
    MagicDNSSuffix: TAILNET,
    CurrentTailnet: { Name: TAILNET, MagicDNSSuffix: TAILNET },
    CertDomains: o.certDomains === undefined ? [SELF_DNS] : o.certDomains,
    Peer:
      peers === null
        ? null
        : Object.fromEntries(
            peers.map((p, i) => [
              `nodekey:${i}`,
              {
                HostName: p.host,
                DNSName: `${p.dns ?? p.host}.${TAILNET}.`,
                TailscaleIPs: p.ips ?? [`100.64.0.${10 + i}`, `fd7a:115c:a1e0::${10 + i}`],
                Online: p.online ?? true,
              },
            ]),
          ),
  });
}

/** A node that is installed but stopped: no peers, no certificate domains. */
export const STOPPED_STATUS = statusJson({ state: "Stopped", certDomains: null, peers: null });

/** `tailscale serve status --json` for one HTTPS port forwarding to a local proxy target. */
export function serveJson(ports: Array<{ port: number; proxy?: string; tcp?: string }>): string {
  const TCP: Record<string, unknown> = {};
  const Web: Record<string, unknown> = {};
  for (const p of ports) {
    if (p.tcp) {
      TCP[String(p.port)] = { TCPForward: p.tcp };
    } else {
      TCP[String(p.port)] = { HTTPS: true };
      Web[`${SELF_DNS}:${p.port}`] = { Handlers: { "/": { Proxy: p.proxy ?? "http://127.0.0.1:3000" } } };
    }
  }
  return ports.length === 0 ? "{}" : JSON.stringify({ TCP, Web });
}

export class FakeTailscaleRunner {
  calls: string[][] = [];
  status = statusJson();
  serve = "{}";
  statusCode = 0;
  runner: CommandRunner = (cmd, args) => {
    this.calls.push([cmd, ...args]);
    const out = args[0] === "serve" ? this.serve : this.status;
    const result: CommandResult = { code: args[0] === "serve" ? 0 : this.statusCode, stdout: out, stderr: "" };
    return Promise.resolve(result);
  };

  /** How many times `status --json` ran. */
  get statusCalls(): number {
    return this.calls.filter((c) => c[1] === "status").length;
  }
}

/** A Tailscale reader over a fake runner. A new reading is taken on every call unless `ttlMs` says otherwise. */
export function fakeTailscale(runner: FakeTailscaleRunner, o: { ttlMs?: number; now?: () => number } = {}): Tailscale {
  return new Tailscale({ runner: runner.runner, find: () => "/fake/tailscale", ttlMs: o.ttlMs ?? 0, now: o.now });
}

export class FakeServeProcess implements ShareProcess {
  killed: Array<"SIGTERM" | "SIGKILL"> = [];
  private output: Array<(chunk: string) => void> = [];
  private finish!: (e: ShareExit) => void;
  exited = new Promise<ShareExit>((resolve) => {
    this.finish = resolve;
  });
  /** Ignore SIGTERM, as a hung child would. */
  stubborn = false;
  constructor(
    readonly bin: string,
    readonly args: string[],
    readonly pid: number,
  ) {}
  onOutput(fn: (chunk: string) => void): void {
    this.output.push(fn);
  }
  say(chunk: string): void {
    for (const fn of this.output) fn(chunk);
  }
  /** The child ends on its own. */
  exit(code: number | null, signal: string | null = null): void {
    this.finish({ code, signal });
  }
  kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
    this.killed.push(signal);
    if (signal === "SIGKILL" || !this.stubborn) this.finish({ code: null, signal });
  }
}

export class FakeSpawner {
  procs: FakeServeProcess[] = [];
  private nextPid = 40000;
  spawn: ShareSpawner = (bin, args) => {
    const proc = new FakeServeProcess(bin, args, this.nextPid++);
    this.procs.push(proc);
    return proc;
  };
}

/** Fire the pending timers that were set with this delay. */
export function fireDelay(timers: ManualTimers, ms: number): number {
  const due = [...timers.pending.entries()].filter(([, t]) => t.ms === ms);
  for (const [id, t] of due) {
    timers.pending.delete(id);
    t.fn();
  }
  return due.length;
}

/** Resolve once `ok` holds, re-checked after every call of the returned `notify`. Rejects after `timeoutMs`. */
export class Changes {
  private waiters = new Set<() => void>();
  notify = (): void => {
    for (const w of [...this.waiters]) w();
  };
  until(ok: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (ok()) return resolve();
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${what}`));
      }, timeoutMs);
      const check = (): void => {
        if (!ok()) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve();
      };
      this.waiters.add(check);
    });
  }
}
