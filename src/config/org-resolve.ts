// src/config/org-resolve.ts
//
// Pure resolver for the per-invocation organization override. Mirrors
// profile-resolve.ts: a `--org` flag or `$REOCLO_ORG` env selects which
// organization (tenant) a single command runs against WITHOUT mutating the
// stored active org (`reoclo org use`). This is what makes parallel agents and
// CI jobs safe — they never clobber each other's "active" org on a shared
// machine.
//
// Precedence: `--org` flag → `$REOCLO_ORG` env → `.reoclo` project file →
// undefined (fall back to the profile's own org). Empty / whitespace-only
// values are treated as unset. The project-file rung sits BELOW the flag/env so
// an explicit per-command override always wins, but ABOVE the profile default
// so a directory's `.reoclo` beats the global active org.

export function resolveOrgOverride(opts: {
  flagOrg?: string;
  envOrg?: string;
  projectOrg?: string;
}): string | undefined {
  return pick(opts.flagOrg) ?? pick(opts.envOrg) ?? pick(opts.projectOrg);
}

function pick(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export type OrgSource = "flag" | "env" | "reoclo" | "active";

/**
 * Resolve the org a command will actually target AND report where that choice
 * came from, for display by `reoclo org current`. Same precedence as
 * {@link resolveOrgOverride}, with the profile's own org as the "active"
 * fallback. Blank / whitespace-only overrides are treated as unset.
 */
export function effectiveOrg(opts: {
  flagOrg?: string;
  envOrg?: string;
  projectOrg?: string;
  profileOrg: string;
}): { org: string; source: OrgSource } {
  const flag = pick(opts.flagOrg);
  if (flag) return { org: flag, source: "flag" };
  const env = pick(opts.envOrg);
  if (env) return { org: env, source: "env" };
  const project = pick(opts.projectOrg);
  if (project) return { org: project, source: "reoclo" };
  return { org: opts.profileOrg, source: "active" };
}
