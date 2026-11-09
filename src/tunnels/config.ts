// src/tunnels/config.ts
//
// The saved-tunnels file (<configDir>/tunnels/tunnels.yaml): schema, load,
// validate and atomic save. Only the daemon writes it, under a file lock.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { withFileLock } from "../config/file-lock";
import { tunnelsFile } from "./paths";

export const TUNNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 600;

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

const common = {
  name: z.string().regex(TUNNEL_NAME_RE, "name must match ^[a-z0-9][a-z0-9-]{0,62}$"),
  org: z.string().min(1),
  tenant_id: z.string().min(1),
  profile: z.string().min(1).optional(),
  /** Phase 1 has one transport; the field is accepted so a later phase's files load. */
  via: z.literal("reoclo").optional(),
  server: z.string().min(1),
  server_id: z.string().min(1),
  keep_up: z.boolean().default(false),
  enabled: z.boolean().default(true),
};

const forwardTunnel = z
  .object({
    ...common,
    kind: z.enum(["tcp", "udp"]),
    target: hostPort,
    local_port: port,
  })
  .strict();

const reverseTunnel = z
  .object({
    ...common,
    kind: z.literal("reverse"),
    remote_port: port,
    local_target: hostPort,
    bind_public: z.boolean().default(false),
  })
  .strict();

/** Keys and values that belong to a later phase, with the phase that adds them. */
function laterPhaseMessage(raw: Record<string, unknown>): string | undefined {
  if (raw["kind"] === "https") return 'kind "https" is not available yet; local HTTPS arrives in phase 2 (REO-625)';
  if ("hostname" in raw) return '"hostname" is not available yet; local hostnames arrive in phase 2 (REO-625)';
  if ("via" in raw) {
    return raw["via"] === "reoclo"
      ? undefined
      : `"via: ${String(raw["via"])}" is not available yet; the Tailscale transport arrives in phase 5 (REO-628)`;
  }
  if ("share" in raw) return '"share" is not available yet; sharing onto the tailnet arrives in phase 6 (REO-629)';
  return undefined;
}

/** One saved tunnel as stored in the file. */
export const TunnelSchema = z
  .unknown()
  .superRefine((raw, ctx) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
    const msg = laterPhaseMessage(raw as Record<string, unknown>);
    if (msg) ctx.addIssue({ code: "custom", message: msg });
  })
  .pipe(z.discriminatedUnion("kind", [forwardTunnel, reverseTunnel]));

export type SavedTunnel = z.infer<typeof TunnelSchema>;
export type ForwardTunnel = Extract<SavedTunnel, { kind: "tcp" | "udp" }>;
export type ReverseTunnel = Extract<SavedTunnel, { kind: "reverse" }>;

export function isReverse(t: SavedTunnel): t is ReverseTunnel {
  return t.kind === "reverse";
}

export const TunnelsFileSchema = z
  .object({
    version: z.literal(1),
    idle_timeout_seconds: z.number().positive().default(DEFAULT_IDLE_TIMEOUT_SECONDS),
    tunnels: z.array(TunnelSchema).default([]),
  })
  .strict()
  .superRefine((file, ctx) => {
    const names = new Set<string>();
    const ports = new Map<number, string>();
    file.tunnels.forEach((t, i) => {
      if (names.has(t.name)) {
        ctx.addIssue({ code: "custom", path: ["tunnels", i, "name"], message: `duplicate tunnel name "${t.name}"` });
      }
      names.add(t.name);
      if (t.kind !== "reverse") {
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
    });
  });

export type TunnelsFile = z.infer<typeof TunnelsFileSchema>;

export function emptyConfig(): TunnelsFile {
  return { version: 1, idle_timeout_seconds: DEFAULT_IDLE_TIMEOUT_SECONDS, tunnels: [] };
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
