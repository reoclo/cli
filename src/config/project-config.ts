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

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILE_NAME = ".reoclo";

/**
 * Walk up from `startDir` to the filesystem root, returning the path of the
 * nearest `.reoclo` file, or null when none exists. `exists` is injectable for
 * tests; it defaults to the real fs in {@link readProjectOrg}.
 */
export function findProjectConfigPath(
  startDir: string,
  exists: (path: string) => boolean,
): string | null {
  let current = startDir;
  for (;;) {
    const candidate = join(current, FILE_NAME);
    if (exists(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null; // reached the filesystem root
    current = parent;
  }
}

export interface ProjectConfigFs {
  exists: (path: string) => boolean;
  read: (path: string) => string;
}

const defaultFs: ProjectConfigFs = {
  exists: existsSync,
  read: (path) => readFileSync(path, "utf8"),
};

/**
 * Resolve the org slug bound to `startDir` via the nearest `.reoclo`, or null
 * when no file is found or the file declares no `org`. Throws a clear Error when
 * the file is present but malformed (invalid JSON, not an object, or an `org`
 * that isn't a non-empty string). Unknown keys are ignored for forward-compat.
 */
export function readProjectOrg(
  startDir: string = process.cwd(),
  fs: ProjectConfigFs = defaultFs,
): string | null {
  const path = findProjectConfigPath(startDir, fs.exists);
  if (!path) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.read(path));
  } catch (e) {
    throw new Error(`malformed ${FILE_NAME} at ${path}: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`malformed ${FILE_NAME} at ${path}: expected a JSON object`);
  }

  const org = (parsed as Record<string, unknown>).org;
  if (org === undefined) return null;
  if (typeof org !== "string" || org.trim() === "") {
    throw new Error(`${FILE_NAME} at ${path}: "org" must be a non-empty string`);
  }
  return org.trim();
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
