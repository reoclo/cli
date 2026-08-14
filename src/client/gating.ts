// src/client/gating.ts
//
// Decides which capability list (if any) gates the CLI's command surface for a
// given run. Extracted as a pure function so it is unit-testable without
// index.ts's `import.meta.main` entry guard.

/**
 * Env credentials (`REOCLO_MACHINE_TOKEN` / `REOCLO_AUTOMATION_KEY`) are
 * ambient, server-enforced, and own no profile — so they must never be gated by
 * a (possibly different) profile's cached capabilities. Returns `undefined` for
 * them, which `filterCommandsByCapability` / `ensureCapabilityOrExit` treat as
 * "unknown → show all / allow, server enforces". For an interactive profile the
 * profile's cached caps pass through unchanged (including `undefined`).
 */
export function resolveGatingCapabilities(args: {
  isEnvCredential: boolean;
  profileCapabilities: string[] | undefined;
}): string[] | undefined {
  return args.isEnvCredential ? undefined : args.profileCapabilities;
}
