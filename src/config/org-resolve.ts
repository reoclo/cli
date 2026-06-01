// src/config/org-resolve.ts
//
// Pure resolver for the per-invocation organization override. Mirrors
// profile-resolve.ts: a `--org` flag or `$REOCLO_ORG` env selects which
// organization (tenant) a single command runs against WITHOUT mutating the
// stored active org (`reoclo org use`). This is what makes parallel agents and
// CI jobs safe — they never clobber each other's "active" org on a shared
// machine.
//
// Precedence: `--org` flag → `$REOCLO_ORG` env → undefined (fall back to the
// profile's own org). Empty / whitespace-only values are treated as unset.

export function resolveOrgOverride(opts: {
  flagOrg?: string;
  envOrg?: string;
}): string | undefined {
  return pick(opts.flagOrg) ?? pick(opts.envOrg);
}

function pick(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
