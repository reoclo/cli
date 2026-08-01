// src/config/org-resolve.ts
//
// Pure resolver for the per-invocation organization override. Mirrors
// profile-resolve.ts: a `--org` flag or `$REOCLO_ORG` env selects which
// organization (tenant) a single command runs against. There is no stored
// "active org" to mutate or fall back to — this is what makes parallel
// agents and CI jobs safe, and what makes a scoped command with no override
// fail loudly (see {@link orgSelectionError}) instead of silently targeting
// the token's login org.
//
// Precedence: `--org` flag → `$REOCLO_ORG` env → `.reoclo` project file →
// unbound. Empty / whitespace-only values are treated as unset. The
// project-file rung sits BELOW the flag/env so an explicit per-command
// override always wins.

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

// "none" = nothing selects an org for this directory (no --org / $REOCLO_ORG
// / .reoclo). There is no "profile" source — an OAuth profile's login org is
// never the target on its own; see {@link orgSelectionError}.
export type OrgSource = "flag" | "env" | "reoclo" | "none";

/**
 * Resolve the org a command will actually target AND report where that choice
 * came from, for display by `reoclo org current`. Same precedence as
 * {@link resolveOrgOverride}. Blank / whitespace-only overrides are treated
 * as unset. Returns `{ org: "", source: "none" }` when nothing selects an
 * org — there is no fallback to a profile's login org.
 */
export function effectiveOrg(opts: {
  flagOrg?: string;
  envOrg?: string;
  projectOrg?: string;
}): { org: string; source: OrgSource } {
  const flag = pick(opts.flagOrg);
  if (flag) return { org: flag, source: "flag" };
  const env = pick(opts.envOrg);
  if (env) return { org: env, source: "env" };
  const project = pick(opts.projectOrg);
  if (project) return { org: project, source: "reoclo" };
  return { org: "", source: "none" };
}

/**
 * Explicit-org policy. An OAuth profile has no implicit "active org": when a
 * scoped command resolves no override (--org / $REOCLO_ORG / .reoclo), it must
 * fail rather than silently target the token's login org. Automation keys and
 * api-key profiles are single-tenant and carry their own org, so they are exempt.
 * Returns the error to throw, or null when selection is satisfied/not required.
 */
export function orgSelectionError(opts: {
  orgRequired: boolean;
  orgOverride: string | undefined;
  authKind: string | undefined;
}): (Error & { exitCode: number }) | null {
  if (opts.orgRequired && !opts.orgOverride && opts.authKind === "oauth") {
    const err = new Error(
      "No organization selected: pass --org <slug> or run 'reoclo init' to bind this directory.",
    ) as Error & { exitCode: number };
    err.exitCode = 4;
    return err;
  }
  return null;
}
