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

/** Minimal structural view of a commander Command — just the merged-options
 *  accessor. `--profile` is a ROOT-level (global) option, so a subcommand only
 *  sees its value through optsWithGlobals(); re-declaring a command-local
 *  `--profile` shadows it (commander assigns the typed value to the global
 *  option and leaves the local one at its default). */
export interface GlobalOptsCommand {
  optsWithGlobals(): Record<string, unknown>;
}

/** The global `--profile` flag's value, or undefined when it was not passed
 *  (or is empty). Reads the flag via optsWithGlobals() — `--profile` is a
 *  ROOT-level option, so subcommands only see it there. keyring/completion use
 *  this directly (flag presence selects one profile vs all / cache scope). */
export function globalProfileFlag(command: GlobalOptsCommand): string | undefined {
  const flag = command.optsWithGlobals().profile;
  return typeof flag === "string" && flag.length > 0 ? flag : undefined;
}

/** Where a resolved profile name came from. */
export type ProfileSource = "flag" | "env" | "default";

/**
 * Like resolveCommandProfile, but also reports WHERE the name came from:
 * `--profile` flag → `flag`, `$REOCLO_PROFILE` → `env`, else the `fallback`
 * → `default`. Precedence and empty/whitespace handling match
 * resolveCommandProfile exactly (blank/unset flag and env are treated as
 * unset). `login` uses the source to decide whether to touch the global
 * active profile and to annotate its feedback.
 */
export function resolveCommandProfileWithSource(
  command: GlobalOptsCommand,
  fallback: string,
): { name: string; source: ProfileSource } {
  const flag = pick(globalProfileFlag(command));
  if (flag) return { name: flag, source: "flag" };
  const env = pick(process.env.REOCLO_PROFILE);
  if (env) return { name: env, source: "env" };
  return { name: fallback, source: "default" };
}

/**
 * Resolve the profile a command should act on from the GLOBAL `--profile` flag,
 * then `$REOCLO_PROFILE`, then the supplied `fallback` (e.g. "default" for
 * `login`, or the config's active profile for `logout`). Reads the flag via
 * optsWithGlobals() so it works regardless of where on the command line
 * `--profile` was placed — and so no command needs (or should have) its own
 * `--profile` option. Thin wrapper over resolveCommandProfileWithSource.
 */
export function resolveCommandProfile(command: GlobalOptsCommand, fallback: string): string {
  return resolveCommandProfileWithSource(command, fallback).name;
}

function pick(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
