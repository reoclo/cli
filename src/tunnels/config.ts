// src/tunnels/config.ts
//
// The saved-tunnels file (<configDir>/tunnels/tunnels.yaml): schema, load,
// validate and atomic save. Only the daemon writes it, under a file lock.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { withFileLock } from "../config/file-lock";
import {
  allowedSuffixes,
  assertValidSuffix,
  HostnameError,
  isValidHostname,
  MAX_ENTRIES,
  suffixFor,
} from "./hosts-block";
import { tunnelsFile } from "./paths";

export const TUNNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 600;
/** An ordinary user cannot bind 127.0.0.1:443 or :444, so the proxy listens here and URLs carry the port. */
export const DEFAULT_HTTPS_PORT = 8443;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const port = z.number().int().min(1).max(65535);
const hostPort = z
  .string()
  .regex(/^[^\s:]+:\d{1,5}$/, "expected HOST:PORT")
  .refine((v) => {
    const p = Number(v.slice(v.lastIndexOf(":") + 1));
    return p >= 1 && p <= 65535;
  }, "port must be between 1 and 65535");

const hostname = z.string().refine(isValidHostname, "hostname must be a lowercase DNS name such as grafana.prod-1.reoclo.localhost");

export const VIA_VALUES = ["reoclo", "tailscale", "auto"] as const;
export type Via = (typeof VIA_VALUES)[number];

const common = {
  name: z.string().regex(TUNNEL_NAME_RE, "name must match ^[a-z0-9][a-z0-9-]{0,62}$"),
  org: z.string().min(1),
  tenant_id: z.string().min(1),
  profile: z.string().min(1).optional(),
  server: z.string().min(1),
  server_id: z.string().min(1),
  keep_up: z.boolean().default(false),
  enabled: z.boolean().default(true),
};

const share = z
  .object({
    tailnet: z.literal(true),
    /** The port other tailnet devices connect to. */
    port,
    /** https tunnels: the plaintext loopback port `tailscale serve` forwards to. Saved so it never changes. */
    internal_port: port.optional(),
  })
  .strict();

export type ShareConfig = z.infer<typeof share>;

/** Fields of a tunnel that dials a target: the transport, how to find the server on the tailnet, and sharing. */
const dialed = {
  via: z.enum(VIA_VALUES).optional(),
  /** The server's own hostname as Reoclo knows it, saved by `add` to find the server among tailnet peers. */
  server_hostname: z.string().min(1).optional(),
  /** Overrides peer matching: a tailnet host name, DNS name or its first label. */
  tailnet_host: z.string().min(1).optional(),
  share: share.optional(),
};

const forwardTunnel = z
  .object({
    ...common,
    ...dialed,
    kind: z.enum(["tcp", "udp"]),
    target: hostPort,
    local_port: port,
    /** Adds a hosts entry only; the tunnel still listens on 127.0.0.1:local_port. */
    hostname: hostname.optional(),
  })
  .strict();

/** Served by the daemon's TLS proxy at https://<hostname>:<https_port>; it binds no port of its own. */
const httpsTunnel = z
  .object({
    ...common,
    ...dialed,
    kind: z.literal("https"),
    target: hostPort,
    hostname,
  })
  .strict();

const reverseTunnel = z
  .object({
    ...common,
    /** A reverse tunnel opens a listener on the server, which only the relay can do. */
    via: z.literal("reoclo").optional(),
    kind: z.literal("reverse"),
    remote_port: port,
    local_target: hostPort,
    bind_public: z.boolean().default(false),
  })
  .strict();

/** Served by the daemon's TLS proxy and forwarded to a TCP address on this machine. No org, server or gateway session. */
const localTunnel = z
  .object({
    name: common.name,
    kind: z.literal("local"),
    hostname,
    local_target: hostPort,
    enabled: z.boolean().default(true),
    keep_up: z.boolean().default(false),
  })
  .strict();

/** One saved tunnel as stored in the file. */
export const TunnelSchema = z
  .discriminatedUnion("kind", [forwardTunnel, httpsTunnel, reverseTunnel, localTunnel])
  .superRefine((t, ctx) => {
    if (t.kind === "reverse" || t.kind === "local") return;
    if (t.via === "tailscale" && t.keep_up) {
      ctx.addIssue({ code: "custom", path: ["keep_up"], message: "keep_up holds a gateway session, so it does not apply to via: tailscale" });
    }
    if (t.share === undefined) return;
    if (t.kind === "udp") {
      ctx.addIssue({ code: "custom", path: ["share"], message: "only tcp and https tunnels can be shared" });
    } else if (t.kind === "https" && t.share.internal_port === undefined) {
      ctx.addIssue({ code: "custom", path: ["share", "internal_port"], message: "an https tunnel's share needs an internal_port" });
    } else if (t.kind === "tcp" && t.share.internal_port !== undefined) {
      ctx.addIssue({ code: "custom", path: ["share", "internal_port"], message: "internal_port applies to https tunnels only" });
    }
  });

export type SavedTunnel = z.infer<typeof TunnelSchema>;
export type ForwardTunnel = Extract<SavedTunnel, { kind: "tcp" | "udp" }>;
export type ReverseTunnel = Extract<SavedTunnel, { kind: "reverse" }>;
export type HttpsTunnel = Extract<SavedTunnel, { kind: "https" }>;
export type LocalTunnel = Extract<SavedTunnel, { kind: "local" }>;
/** Tunnels that dial a server target and so can use the tailnet. */
export type DialedTunnel = ForwardTunnel | HttpsTunnel;

export function isReverse(t: SavedTunnel): t is ReverseTunnel {
  return t.kind === "reverse";
}

export function isHttps(t: SavedTunnel): t is HttpsTunnel {
  return t.kind === "https";
}

export function isLocal(t: SavedTunnel): t is LocalTunnel {
  return t.kind === "local";
}

/** tcp and udp tunnels: the ones with a fixed local port. */
export function isForward(t: SavedTunnel): t is ForwardTunnel {
  return t.kind === "tcp" || t.kind === "udp";
}

/** The transport a tunnel uses; a tunnel saved without one uses the relay. */
export function viaOf(t: SavedTunnel): Via {
  return t.kind === "reverse" || t.kind === "local" ? "reoclo" : (t.via ?? "reoclo");
}

/** The hostname a tunnel answers to, when it has one. */
export function hostnameOf(t: SavedTunnel): string | undefined {
  return t.kind === "reverse" ? undefined : t.hostname;
}

export const TunnelsFileSchema = z
  .object({
    version: z.literal(1),
    idle_timeout_seconds: z.number().positive().default(DEFAULT_IDLE_TIMEOUT_SECONDS),
    /** Where the TLS proxy listens on 127.0.0.1 and ::1. */
    https_port: port.default(DEFAULT_HTTPS_PORT),
    /** `required`: an agent's request to change hostnames, trust the CA or open reverse or public tunnels waits for a person. `off`: agents may do what the CLI can. */
    agent_approvals: z.enum(["required", "off"]).default("required"),
    /** Custom suffixes the local CA may sign for, beyond reoclo.localhost. */
    ca_suffixes: z.array(z.string()).default([]),
    /** Hostnames added to the hosts block with no tunnel behind them. */
    manual_hosts: z.array(z.string()).default([]),
    tunnels: z.array(TunnelSchema).default([]),
  })
  .strict()
  .superRefine((file, ctx) => {
    const names = new Set<string>();
    const ports = new Map<number, string>();
    const sharePorts = new Map<number, string>();
    const hosts = new Map<string, string>();
    file.ca_suffixes.forEach((s, i) => {
      try {
        assertValidSuffix(s);
      } catch (e) {
        if (!(e instanceof HostnameError)) throw e;
        ctx.addIssue({ code: "custom", path: ["ca_suffixes", i], message: e.message });
      }
    });
    if (file.manual_hosts.length > MAX_ENTRIES) {
      ctx.addIssue({ code: "custom", path: ["manual_hosts"], message: `at most ${MAX_ENTRIES} manual hostnames` });
    }
    const claim = (host: string, owner: string, path: (string | number)[]): void => {
      const prior = hosts.get(host);
      if (prior !== undefined) {
        ctx.addIssue({ code: "custom", path, message: `hostname "${host}" is already used by ${prior}` });
      }
      hosts.set(host, owner);
      if (suffixFor(host, file.ca_suffixes) === undefined && !(owner === "a manual host" && host.endsWith(".localhost"))) {
        ctx.addIssue({
          code: "custom",
          path,
          message: `hostname "${host}" must end in ${allowedSuffixes(file.ca_suffixes).join(" or ")}; add a custom suffix with: reoclo tunnel trust --domain <suffix>`,
        });
      }
    };
    file.manual_hosts.forEach((h, i) => {
      if (!isValidHostname(h)) {
        ctx.addIssue({ code: "custom", path: ["manual_hosts", i], message: `${JSON.stringify(h)} is not a valid hostname` });
        return;
      }
      claim(h, "a manual host", ["manual_hosts", i]);
    });
    file.tunnels.forEach((t, i) => {
      if (names.has(t.name)) {
        ctx.addIssue({ code: "custom", path: ["tunnels", i, "name"], message: `duplicate tunnel name "${t.name}"` });
      }
      names.add(t.name);
      const host = hostnameOf(t);
      if (host !== undefined) claim(host, `tunnel "${t.name}"`, ["tunnels", i, "hostname"]);
      if (isForward(t)) {
        const owner = ports.get(t.local_port);
        if (owner !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["tunnels", i, "local_port"],
            message: `local_port ${t.local_port} is already used by tunnel "${owner}"`,
          });
        }
        ports.set(t.local_port, t.name);
      }
      if (t.kind !== "reverse" && t.kind !== "local" && t.share !== undefined) {
        const owner = sharePorts.get(t.share.port);
        if (owner !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["tunnels", i, "share", "port"],
            message: `share port ${t.share.port} is already used by tunnel "${owner}"`,
          });
        }
        sharePorts.set(t.share.port, t.name);
      }
    });
    file.tunnels.forEach((t, i) => {
      const internal = t.kind === "https" ? t.share?.internal_port : undefined;
      const clash = internal === undefined ? undefined : ports.get(internal);
      if (internal !== undefined && clash !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["tunnels", i, "share", "internal_port"],
          message: `internal_port ${internal} is already used as the local_port of tunnel "${clash}"`,
        });
      }
    });
  });

export type TunnelsFile = z.infer<typeof TunnelsFileSchema>;

export function emptyConfig(): TunnelsFile {
  return {
    version: 1,
    idle_timeout_seconds: DEFAULT_IDLE_TIMEOUT_SECONDS,
    https_port: DEFAULT_HTTPS_PORT,
    agent_approvals: "required",
    ca_suffixes: [],
    manual_hosts: [],
    tunnels: [],
  };
}

function describeIssues(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      const where = i.path.length > 0 ? `${i.path.join(".")}: ` : "";
      return `${where}${i.message}`;
    })
    .join("; ");
}

/** Validate one tunnel. Throws ConfigError naming every problem. */
export function parseTunnel(raw: unknown): SavedTunnel {
  const r = TunnelSchema.safeParse(raw);
  if (!r.success) throw new ConfigError(describeIssues(r.error));
  return r.data;
}

/** Validate a whole file. Throws ConfigError naming every problem. */
export function parseConfig(raw: unknown): TunnelsFile {
  const r = TunnelsFileSchema.safeParse(raw);
  if (!r.success) throw new ConfigError(describeIssues(r.error));
  return r.data;
}

/** Read the file. A missing file is an empty config; a broken one throws. */
export function loadConfig(path: string = tunnelsFile()): TunnelsFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyConfig();
    throw e;
  }
  let raw: unknown;
  try {
    raw = yaml.load(text);
  } catch (e) {
    throw new ConfigError(`${path} is not valid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (raw === undefined || raw === null) return emptyConfig();
  try {
    return parseConfig(raw);
  } catch (e) {
    throw new ConfigError(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Write the file atomically: a temp file in the same directory, then rename. */
export function saveConfig(file: TunnelsFile, path: string = tunnelsFile()): void {
  const valid = parseConfig(file);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, yaml.dump(valid, { lineWidth: 100, noRefs: true }), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Load, change and save under the file lock, so two writers never lose an update. */
export async function updateConfig<T>(
  fn: (file: TunnelsFile) => T,
  path: string = tunnelsFile(),
): Promise<T> {
  return withFileLock(`${path}.lock`, () => {
    const file = loadConfig(path);
    const result = fn(file);
    saveConfig(file, path);
    return Promise.resolve(result);
  });
}
