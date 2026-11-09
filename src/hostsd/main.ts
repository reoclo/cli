// src/hostsd/main.ts
//
// The root hosts helper. It does one job: keep the managed block of /etc/hosts
// in step with the hostnames the user's tunnel daemon asks for, and optionally
// relay port 443 to the daemon's TLS port.
//
// It trusts nothing it is sent. Every path comes from its caller's options (the
// entry point fixes them), the allowlist comes from its own root-owned config,
// a request has no address field, and each hostname must be a subdomain of
// .localhost or of an allowlisted suffix. Bun exposes no peer credentials, so
// access control is file permissions: the socket lives in a directory owned by
// the installing user with mode 0700.

import net from "node:net";
import { chmodSync, chownSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { MAX_ENTRIES, readBlock, replaceBlock, validateHelperEntry } from "../tunnels/hosts-block";
import { readHostsFile, rewriteHostsFile } from "./hosts-file";

export const HostsdConfigSchema = z
  .object({
    version: z.literal(1),
    /** The user who installed the helper; the only user who can reach the socket. */
    uid: z.number().int().min(0),
    allow_suffixes: z.array(z.string()).default([]),
    port_443: z.boolean().default(false),
    /** The daemon's https_port, recorded at setup. The relay forwards only here. */
    relay_port: z.number().int().min(1).max(65535).optional(),
  })
  .strict();

export type HostsdConfig = z.infer<typeof HostsdConfigSchema>;

export interface RelayStatus {
  enabled: boolean;
  listening: boolean;
  /** The port the relay forwards to. */
  port?: number;
  error?: string;
}

export interface HelperStatus {
  version: string;
  entries: number;
  suffixes: string[];
  relay: RelayStatus;
}

export interface HostsdOptions {
  configFile: string;
  hostsFile: string;
  socketPath: string;
  version: string;
  platform?: NodeJS.Platform;
  /** Flush the system DNS cache after a rewrite. Default: dscacheutil and mDNSResponder on macOS. */
  flushDns?: () => Promise<void>;
  /** The port the relay listens on. Default 443. */
  relayListenPort?: number;
  /** True when something already answers on the port. Default: try 127.0.0.1 and ::1. */
  probe?: (port: number) => Promise<boolean>;
  log?: (line: string) => void;
}

export interface HostsdHandle {
  socketPath: string;
  relay(): RelayStatus;
  stop(): Promise<void>;
}

const MAX_LINE = 256 * 1024;

export function readConfig(path: string): HostsdConfig {
  return HostsdConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function answers(port: number, host: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v: boolean): void => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

async function defaultProbe(port: number): Promise<boolean> {
  return (await answers(port, "127.0.0.1")) || (await answers(port, "::1"));
}

async function defaultFlush(platform: NodeJS.Platform): Promise<void> {
  if (platform !== "darwin") return;
  const { realRunner } = await import("../tunnels/command-runner");
  await realRunner("dscacheutil", ["-flushcache"]);
  await realRunner("killall", ["-HUP", "mDNSResponder"]);
}

class Relay {
  private servers: net.Server[] = [];
  private current: RelayStatus = { enabled: false, listening: false };

  constructor(
    private readonly listenPort: number,
    private readonly probe: (port: number) => Promise<boolean>,
    private readonly log: (line: string) => void,
  ) {}

  status(): RelayStatus {
    return this.current;
  }

  /** Start the relay when the config wants it and nothing answers on its port. Safe to call often. */
  async ensure(cfg: HostsdConfig): Promise<void> {
    if (!cfg.port_443 || cfg.relay_port === undefined) {
      await this.stop();
      this.current = { enabled: false, listening: false };
      return;
    }
    if (this.current.listening && this.current.port === cfg.relay_port) return;
    await this.stop();
    this.current = { enabled: true, listening: false, port: cfg.relay_port };
    if (await this.probe(this.listenPort)) {
      this.current.error = `something already answers on port ${this.listenPort}, so the relay stays off`;
      this.log(this.current.error);
      return;
    }
    const target = cfg.relay_port;
    const make = (host: string): Promise<net.Server> =>
      new Promise((resolve, reject) => {
        const server = net.createServer((client) => {
          const upstream = net.connect({ port: target, host: "127.0.0.1" });
          client.on("error", () => upstream.destroy());
          upstream.on("error", () => client.destroy());
          client.pipe(upstream).pipe(client);
        });
        server.once("error", reject);
        server.listen({ port: this.listenPort, host }, () => resolve(server));
      });
    try {
      this.servers.push(await make("127.0.0.1"));
    } catch (err) {
      this.current.error = `could not listen on 127.0.0.1:${this.listenPort}: ${err instanceof Error ? err.message : String(err)}`;
      this.log(this.current.error);
      return;
    }
    try {
      this.servers.push(await make("::1"));
    } catch (err) {
      this.log(`relay: no IPv6 listener: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.current.listening = true;
    this.log(`relaying port ${this.listenPort} to 127.0.0.1:${target}`);
  }

  async stop(): Promise<void> {
    const servers = this.servers;
    this.servers = [];
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    this.current = { ...this.current, listening: false };
  }
}

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

export async function startHostsd(opts: HostsdOptions): Promise<HostsdHandle> {
  const log = opts.log ?? (() => undefined);
  const platform = opts.platform ?? process.platform;
  const flush = opts.flushDns ?? (() => defaultFlush(platform));
  const relay = new Relay(opts.relayListenPort ?? 443, opts.probe ?? defaultProbe, log);
  const boot = readConfig(opts.configFile);

  // The directory stays root's until the socket is ready. chmod and chown below
  // follow symlinks, so in a directory the user already owns (any restart) a
  // swapped socket path would hand them ownership of an arbitrary file.
  const socketDir = dirname(opts.socketPath);
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  if (process.getuid?.() === 0) chownSync(socketDir, 0, -1);
  chmodSync(socketDir, 0o700);
  rmSync(opts.socketPath, { force: true });

  let writing: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = writing.then(fn, fn);
    writing = run.catch(() => undefined);
    return run;
  };

  const status = (cfg: HostsdConfig): HelperStatus => ({
    version: opts.version,
    entries: readBlock(readHostsFile(opts.hostsFile)).length,
    suffixes: cfg.allow_suffixes,
    relay: relay.status(),
  });

  const handle = async (raw: string): Promise<unknown> => {
    let req: unknown;
    try {
      req = JSON.parse(raw);
    } catch {
      return fail("the request is not valid JSON");
    }
    if (req === null || typeof req !== "object" || Array.isArray(req)) return fail("the request must be an object");
    const body = req as Record<string, unknown>;
    let cfg: HostsdConfig;
    try {
      cfg = readConfig(opts.configFile);
    } catch (err) {
      return fail(`the helper's config is unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
    await relay.ensure(cfg);

    if (body["op"] === "status") return { ok: true, ...status(cfg) };
    if (body["op"] !== "set") return fail(`unknown op ${JSON.stringify(body["op"])}`);

    const extra = Object.keys(body).filter((k) => k !== "op" && k !== "entries");
    if (extra.length > 0) return fail(`unexpected field ${JSON.stringify(extra[0])}; a request carries entries only`);
    const entries = body["entries"];
    if (!Array.isArray(entries)) return fail("entries must be an array of hostnames");
    if (entries.length > MAX_ENTRIES) return fail(`at most ${MAX_ENTRIES} hostnames per request`);
    for (const e of entries) {
      if (typeof e !== "string") return fail("every entry must be a hostname string");
      const problem = validateHelperEntry(e, cfg.allow_suffixes);
      if (problem) return fail(problem);
    }
    try {
      const wrote = await exclusive(async () => {
        const result = rewriteHostsFile(opts.hostsFile, (text) => replaceBlock(text, entries as string[]));
        if (result.changed) await flush();
        return result.changed;
      });
      if (wrote) log(`wrote ${entries.length} hostnames to ${opts.hostsFile}`);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    return { ok: true, ...status(cfg) };
  };

  const server = net.createServer((conn) => {
    let buffered = "";
    conn.setEncoding("utf8");
    conn.on("error", () => conn.destroy());
    conn.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.length > MAX_LINE) {
        buffered = "";
        conn.removeAllListeners("data");
        conn.end(JSON.stringify(fail("the request is too large")) + "\n");
        return;
      }
      let nl: number;
      while ((nl = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        void handle(line).then((reply) => conn.write(JSON.stringify(reply) + "\n"));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.socketPath, () => resolve());
  });
  chmodSync(opts.socketPath, 0o600);
  chownSync(opts.socketPath, boot.uid, -1);
  chownSync(socketDir, boot.uid, -1);
  await relay.ensure(boot);
  log(`hosts helper ${opts.version} listening on ${opts.socketPath}`);

  return {
    socketPath: opts.socketPath,
    relay: () => relay.status(),
    async stop() {
      await relay.stop();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(opts.socketPath, { force: true });
    },
  };
}
