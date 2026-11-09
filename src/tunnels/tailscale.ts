// src/tunnels/tailscale.ts
//
// What the daemon knows about Tailscale on this machine: where the CLI is,
// whether the node is running, which peers it can see, and what `tailscale
// serve` already publishes. Every call goes through an injected command runner,
// so tests never start the real CLI. Only `status --json` and `serve status
// --json` are ever run here; changing anything is the share supervisor's job.

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { realRunner, type CommandRunner } from "./command-runner";

/** Overrides the search for the CLI. When set, it is the only place looked at. */
export const TAILSCALE_PATH_ENV = "REOCLO_TAILSCALE_PATH";
export const MAC_APP_BINARY = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
export const STATUS_TTL_MS = 30_000;

export interface TailscalePeer {
  host_name: string;
  dns_name: string;
  addresses: string[];
  online: boolean;
}

export interface TailscaleInfo {
  installed: boolean;
  running: boolean;
  /** Tailscale's own word for it, such as Running or Stopped. */
  backend_state?: string;
  tailnet?: string;
  /** True when the tailnet has HTTPS certificates turned on. */
  https_certificates: boolean;
  /** This machine's name on the tailnet, without the trailing dot. */
  self_dns_name?: string;
  peers: TailscalePeer[];
  /** Why the state is unknown: the CLI is missing or its output was not JSON. */
  error?: string;
}

export interface ServedPort {
  port: number;
  kind: "https" | "http" | "tcp";
  /** What the port forwards to, when Tailscale says. */
  target?: string;
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
}

function text(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function dnsName(v: unknown): string | undefined {
  return text(v)?.replace(/\.$/, "");
}

/** The file to run, or undefined when Tailscale is not installed. */
export function findTailscaleBinary(
  o: { override?: string; path?: string; exists?: (p: string) => boolean; app?: string } = {},
): string | undefined {
  const exists = o.exists ?? existsSync;
  const override = "override" in o ? o.override : process.env[TAILSCALE_PATH_ENV];
  if (override !== undefined && override !== "") return exists(override) ? override : undefined;
  for (const dir of (o.path ?? process.env["PATH"] ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, "tailscale");
    if (exists(candidate)) return candidate;
  }
  const app = o.app ?? MAC_APP_BINARY;
  return exists(app) ? app : undefined;
}

/** Read `tailscale status --json`. A stopped node still answers, with no peers and no certificate domains. */
export function parseStatus(raw: unknown): Omit<TailscaleInfo, "installed"> {
  const root = obj(raw) ?? {};
  const backend = text(root["BackendState"]);
  const current = obj(root["CurrentTailnet"]);
  const certDomains = Array.isArray(root["CertDomains"]) ? root["CertDomains"] : [];
  const peers: TailscalePeer[] = [];
  const peerMap = obj(root["Peer"]);
  for (const value of peerMap ? Object.values(peerMap) : []) {
    const p = obj(value);
    if (!p) continue;
    const addresses = Array.isArray(p["TailscaleIPs"]) ? p["TailscaleIPs"].filter((a): a is string => typeof a === "string") : [];
    peers.push({
      host_name: text(p["HostName"]) ?? "",
      dns_name: dnsName(p["DNSName"]) ?? "",
      addresses,
      online: p["Online"] === true,
    });
  }
  const tailnet = text(current?.["Name"]) ?? text(root["MagicDNSSuffix"]) ?? text(current?.["MagicDNSSuffix"]);
  const self = dnsName(obj(root["Self"])?.["DNSName"]);
  return {
    running: backend === "Running",
    ...(backend ? { backend_state: backend } : {}),
    ...(tailnet ? { tailnet } : {}),
    https_certificates: certDomains.some((d) => typeof d === "string" && d !== ""),
    ...(self ? { self_dns_name: self } : {}),
    peers,
  };
}

/** Read `tailscale serve status --json`: the ports this machine already publishes. */
export function parseServeStatus(raw: unknown): ServedPort[] {
  const root = obj(raw) ?? {};
  const tcp = obj(root["TCP"]) ?? {};
  const web = obj(root["Web"]) ?? {};
  const out: ServedPort[] = [];
  for (const [key, value] of Object.entries(tcp)) {
    const port = Number(key);
    const entry = obj(value) ?? {};
    if (!Number.isInteger(port)) continue;
    const forward = text(entry["TCPForward"]);
    if (forward) {
      out.push({ port, kind: "tcp", target: forward });
      continue;
    }
    const handlers = Object.entries(web).find(([host]) => host.endsWith(`:${port}`));
    const first = Object.values(obj(obj(handlers?.[1])?.["Handlers"]) ?? {})[0];
    const target = text(obj(first)?.["Proxy"]) ?? text(obj(first)?.["Path"]) ?? text(obj(first)?.["Text"]);
    out.push({ port, kind: entry["HTTPS"] === true ? "https" : "http", ...(target ? { target } : {}) });
  }
  return out.sort((a, b) => a.port - b.port);
}

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * The peer a Reoclo server is on the tailnet: `HostName` first, then the first
 * label of `DNSName`, then the whole DNS name. An online peer wins a tie.
 */
export function matchPeer(info: Pick<TailscaleInfo, "peers">, wanted: string): TailscalePeer | undefined {
  const w = normalize(wanted);
  if (w === "") return undefined;
  const rank = (p: TailscalePeer): number => {
    if (normalize(p.host_name) === w) return 0;
    if (normalize(p.dns_name).split(".")[0] === w) return 1;
    if (normalize(p.dns_name) === w) return 2;
    return 3;
  };
  const found = info.peers.filter((p) => rank(p) < 3);
  found.sort((a, b) => rank(a) - rank(b) || Number(b.online) - Number(a.online));
  return found[0];
}

export function firstIpv4(addresses: readonly string[]): string | undefined {
  return addresses.find((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a));
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "::1" || h === "[::1]" || /^127\./.test(h);
}

function loopbackAddress(address: string): boolean {
  return isLoopbackHost(address.replace(/^\[|\]$/g, ""));
}

export interface ScannedPort {
  port: number;
  protocol: string;
  bind_address: string;
}

/**
 * Why the tailnet cannot reach a port, going by the server's stored port scan:
 * set when every listener on the port is on a loopback address. A port missing
 * from the scan is allowed, because the scan may be stale.
 */
export function portBindProblem(ports: readonly ScannedPort[] | undefined, port: number, proto: "tcp" | "udp"): string | undefined {
  const seen = (ports ?? []).filter((p) => p.port === port && (p.protocol.toLowerCase().startsWith("udp") ? "udp" : "tcp") === proto);
  if (seen.length === 0 || seen.some((p) => !loopbackAddress(p.bind_address))) return undefined;
  return `port ${port} listens only on ${seen[0]?.bind_address ?? "127.0.0.1"} on the server, so the tailnet cannot reach it; bind it to 0.0.0.0 or use via: reoclo`;
}

/** Why a target cannot be dialed over the tailnet, for a forward tunnel's `host:port`. */
export function targetProblem(kind: "tcp" | "udp" | "https", target: string, ports?: readonly ScannedPort[]): string | undefined {
  const i = target.lastIndexOf(":");
  const host = target.slice(0, i);
  const port = Number(target.slice(i + 1));
  if (!isLoopbackHost(host)) return `the target host ${host} is not loopback, and only the server can resolve it, so it cannot be dialed over the tailnet`;
  return portBindProblem(ports, port, kind === "udp" ? "udp" : "tcp");
}

export interface TailscaleOptions {
  runner?: CommandRunner;
  /** Where the CLI is. Default: the search above. */
  find?: () => string | undefined;
  now?: () => number;
  ttlMs?: number;
}

export class Tailscale {
  private readonly runner: CommandRunner;
  private readonly find: () => string | undefined;
  private readonly now: () => number;
  private readonly ttl: number;
  private cached?: { at: number; info: TailscaleInfo };
  private inflight?: Promise<TailscaleInfo>;

  constructor(opts: TailscaleOptions = {}) {
    this.runner = opts.runner ?? realRunner;
    this.find = opts.find ?? (() => findTailscaleBinary());
    this.now = opts.now ?? Date.now;
    this.ttl = opts.ttlMs ?? STATUS_TTL_MS;
  }

  binary(): string | undefined {
    return this.find();
  }

  /** The node's state, cached for 30 seconds unless `fresh` asks for a new reading. */
  status(o: { fresh?: boolean } = {}): Promise<TailscaleInfo> {
    if (!o.fresh && this.cached && this.now() - this.cached.at < this.ttl) return Promise.resolve(this.cached.info);
    if (this.inflight) return this.inflight;
    const run = this.read().then((info) => {
      this.cached = { at: this.now(), info };
      return info;
    });
    this.inflight = run;
    const clear = (): void => {
      if (this.inflight === run) this.inflight = undefined;
    };
    run.then(clear, clear);
    return run;
  }

  private async read(): Promise<TailscaleInfo> {
    const bin = this.find();
    if (bin === undefined) {
      return { installed: false, running: false, https_certificates: false, peers: [], error: "Tailscale is not installed on this machine" };
    }
    const res = await this.runner(bin, ["status", "--json"]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      const line = (res.stderr || res.stdout).trim().split("\n")[0] ?? "";
      return {
        installed: true,
        running: false,
        https_certificates: false,
        peers: [],
        error: line === "" ? `tailscale status exited with code ${res.code}` : line,
      };
    }
    return { installed: true, ...parseStatus(parsed) };
  }

  /** The ports `tailscale serve` publishes now. Empty when the CLI is missing or its answer is not JSON. */
  async served(): Promise<ServedPort[]> {
    const bin = this.find();
    if (bin === undefined) return [];
    const res = await this.runner(bin, ["serve", "status", "--json"]);
    try {
      return parseServeStatus(JSON.parse(res.stdout));
    } catch {
      return [];
    }
  }
}

export interface TailscaleStatusView {
  installed: boolean;
  running: boolean;
  state?: string;
  tailnet?: string;
  https_certificates: boolean;
  error?: string;
}

export function statusView(info: TailscaleInfo): TailscaleStatusView {
  return {
    installed: info.installed,
    running: info.running,
    ...(info.backend_state ? { state: info.backend_state } : {}),
    ...(info.tailnet ? { tailnet: info.tailnet } : {}),
    https_certificates: info.https_certificates,
    ...(info.error ? { error: info.error } : {}),
  };
}
