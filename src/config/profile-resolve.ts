// src/config/profile-resolve.ts
//
// Pure helpers for resolving which named profile a command should use. Kept
// dependency-free so they run both before commander parses (capability gating
// in index.ts) and inside bootstrap() at request time.

const PROFILE_FLAG = "--profile";
const PROFILE_FLAG_EQ = "--profile=";

/**
 * Extract the value of a `--profile <name>` / `--profile=<name>` flag from a
 * raw argv array. Best-effort and position-independent — used before commander
 * parses so capability gating can reflect the selected profile. Returns
 * undefined when the flag is absent or has no usable value.
 */
export function extractProfileFromArgv(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg == null) continue;
    if (arg === PROFILE_FLAG) {
      const next = argv[i + 1];
      // Don't swallow the next token if it's itself a flag (e.g. a dangling
      // `--profile` followed by `-o json`).
      return next && !next.startsWith("-") ? next : undefined;
    }
    if (arg.startsWith(PROFILE_FLAG_EQ)) {
      const value = arg.slice(PROFILE_FLAG_EQ.length);
      return value || undefined;
    }
  }
  return undefined;
}

/**
 * Resolve the effective profile name from the precedence chain:
 *   1. explicit `--profile` flag (CLI flag — most specific)
 *   2. `$REOCLO_PROFILE` environment variable
 *   3. the config's active profile (set by `reoclo login` / `reoclo profile use`)
 *
 * Empty / whitespace-only flag and env values are treated as unset so they
 * don't shadow the active profile.
 */
export function resolveProfileName(opts: {
  flagProfile?: string;
  envProfile?: string;
  activeProfile: string;
}): string {
  return pick(opts.flagProfile) ?? pick(opts.envProfile) ?? opts.activeProfile;
}

function pick(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
