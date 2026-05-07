import type { Command } from "commander";

const CAPABILITY_KEY = Symbol("requireCapability");

interface CommandWithCapability extends Command {
  [CAPABILITY_KEY]?: string;
}

/** Tag a Commander command with the capability it requires. */
export function requireCapability(cmd: Command, verb: string): Command {
  (cmd as CommandWithCapability)[CAPABILITY_KEY] = verb;
  return cmd;
}

/** Read the capability tag (returns null if untagged). */
export function getRequiredCapability(cmd: Command): string | null {
  return (cmd as CommandWithCapability)[CAPABILITY_KEY] ?? null;
}

/** Throw an exit-coded error if the capability is missing. */
export function ensureCapabilityOrExit(
  capabilities: string[] | undefined,
  verb: string,
): void {
  if (capabilities && capabilities.includes(verb)) return;
  const err = new Error(
    `missing capability "${verb}" — ask your tenant admin to grant it (or assign a role that includes it)`,
  ) as Error & { exitCode: number };
  err.exitCode = 13;
  throw err;
}
