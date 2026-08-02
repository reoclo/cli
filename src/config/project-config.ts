// src/config/project-config.ts
//
// Per-directory project binding. A `.reoclo` file (JSON) in a project tree pins
// which organization commands run against, without touching the global active
// org in ~/.reoclo/config.json. Discovery walks up from the current directory to
// the filesystem root and the NEAREST `.reoclo` wins — the same model as `.git`.
//
// The resolved org feeds the existing per-invocation override seam
// (org-resolve.ts) BELOW `--org` / `$REOCLO_ORG`, so an explicit flag/env still
// wins per command. A malformed file fails loud rather than silently falling
// back to the profile's org — running against the wrong org is the hazard this
// feature exists to remove.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const FILE_NAME = ".reoclo";

/**
 * Walk up from `startDir` to the filesystem root, returning the path of the
 * nearest `.reoclo` REGULAR FILE, or null when none exists. A candidate that
 * exists but isn't a regular file (e.g. the `~/.reoclo` global config
 * directory) is silently skipped — it isn't a project binding. `exists` and
 * `isFile` are injectable for tests; they default to the real fs in
 * {@link readProjectOrg}.
 */
export function findProjectConfigPath(
  startDir: string,
  exists: (path: string) => boolean,
  isFile: (path: string) => boolean,
): string | null {
  let current = startDir;
  for (;;) {
    const candidate = join(current, FILE_NAME);
    if (exists(candidate) && isFile(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null; // reached the filesystem root
    current = parent;
  }
}

export interface ProjectConfigFs {
  exists: (path: string) => boolean;
  isFile: (path: string) => boolean;
  read: (path: string) => string;
  warn?: (line: string) => void;
}

const defaultFs: ProjectConfigFs = {
  exists: existsSync,
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  read: (path) => readFileSync(path, "utf8"),
  warn: (line) => process.stderr.write(line),
};

/** The `.reoclo` schema version this CLI writes. Bump when the shape of the
 *  file changes in a way older CLI versions can't read correctly. */
export const PROJECT_CONFIG_VERSION = 1;

export interface ProjectConfig {
  org?: string;
  profile?: string;
  version?: number;
  skills?: { ref: string; sha?: string; installed_at?: string };
}

/** Read + validate a present `<key>` as a non-empty string. Absent → undefined;
 *  present-but-invalid → throw (fail loud rather than run against the wrong
 *  target). */
function stringField(obj: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${FILE_NAME} at ${path}: "${key}" must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Parse the nearest `.reoclo` into its recognized fields (`org`, `profile`), or
 * null when no file is found. Throws a clear Error when the file is present but
 * malformed (invalid JSON, not an object, or a recognized field that isn't a
 * non-empty string). Unknown keys are ignored for forward-compat.
 */
export function readProjectConfig(
  startDir: string = process.cwd(),
  fs: ProjectConfigFs = defaultFs,
): ProjectConfig | null {
  const path = findProjectConfigPath(startDir, fs.exists, fs.isFile);
  if (!path) return null;

  let raw: string;
  try {
    raw = fs.read(path);
  } catch (e) {
    // Filesystem-level failure (permission / is-a-dir / IO): this is not an
    // intentional-but-broken binding, so skip it gracefully instead of crashing.
    (fs.warn ?? ((l) => process.stderr.write(l)))(
      `warning: ignoring unreadable .reoclo at ${path}: ${(e as Error).message}\n`,
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`malformed ${FILE_NAME} at ${path}: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`malformed ${FILE_NAME} at ${path}: expected a JSON object`);
  }

  const obj = parsed as Record<string, unknown>;
  const config: ProjectConfig = {};
  const org = stringField(obj, "org", path);
  const profile = stringField(obj, "profile", path);
  if (org !== undefined) config.org = org;
  if (profile !== undefined) config.profile = profile;

  // `version` and `skills` are tolerant, forward-compat reads: an
  // unrecognized or malformed shape is ignored rather than thrown, unlike
  // `org`/`profile` above (those gate which backend commands run against, so
  // they fail loud instead).
  const version = obj.version;
  if (typeof version === "number" && Number.isFinite(version)) config.version = version;
  const skills = obj.skills;
  if (skills && typeof skills === "object" && !Array.isArray(skills)) {
    const s = skills as Record<string, unknown>;
    if (typeof s.ref === "string" && s.ref.trim() !== "") {
      config.skills = {
        ref: s.ref.trim(),
        sha: typeof s.sha === "string" ? s.sha : undefined,
        installed_at: typeof s.installed_at === "string" ? s.installed_at : undefined,
      };
    }
  }
  return config;
}

/** A present project config is "outdated" (or plain/legacy) when its version is
 *  behind the CLI's PROJECT_CONFIG_VERSION. A missing version counts as 0. */
export function projectConfigOutdated(cfg: ProjectConfig | null): boolean {
  if (!cfg) return false;
  return (cfg.version ?? 0) < PROJECT_CONFIG_VERSION;
}

/**
 * Resolve the org slug bound to `startDir` via the nearest `.reoclo`, or null
 * when no file is found or the file declares no `org`. Thin wrapper over
 * {@link readProjectConfig}; shares its fail-loud behaviour on a malformed file.
 */
export function readProjectOrg(
  startDir: string = process.cwd(),
  fs: ProjectConfigFs = defaultFs,
): string | null {
  return readProjectConfig(startDir, fs)?.org ?? null;
}

/**
 * Decide the project org to feed into the org-override precedence, applying the
 * safety rule: `.reoclo` is ambient, committed-to-the-repo config, so it only
 * applies to OAuth profiles (the only auth that can `tenant_switch`). Under an
 * automation key (no profile) or an api-key profile the file is NEVER EVEN READ
 * — `readOrg` is a thunk and stays uncalled — so a malformed committed `.reoclo`
 * can't throw and break CI. Explicit `--org` / `$REOCLO_ORG` keep their own
 * (stricter) handling in bootstrap().
 */
export function projectOrgFor(
  authKind: string | undefined,
  readOrg: () => string | null,
): string | undefined {
  if (authKind !== "oauth") return undefined;
  return readOrg() ?? undefined;
}
