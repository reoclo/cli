import type { Command } from "commander";
import type { ResourceKind } from "../completion/types";

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
    `missing capability "${verb}" — ask your organization admin to grant it (or assign a role that includes it)`,
  ) as Error & { exitCode: number };
  err.exitCode = 13;
  throw err;
}

const COMPLETION_KEY = Symbol("withCompletion");

/** A flag completes to a dynamic resource, or to a fixed set of strings. */
export type ResourceRef = ResourceKind | { enum: string[] };

export interface CompletionSpec {
  /** Positional arg slots (0-indexed after the command's subcommand path). */
  args?: { slot: number; resource: ResourceKind }[];
  /** Long-flag name → resource or fixed enum. */
  flags?: Record<string, ResourceRef>;
}

interface CommandWithCompletion extends Command {
  [COMPLETION_KEY]?: CompletionSpec;
}

/** Tag a command with its completion metadata. */
export function withCompletion(cmd: Command, spec: CompletionSpec): Command {
  (cmd as CommandWithCompletion)[COMPLETION_KEY] = spec;
  return cmd;
}

/** Read the completion spec (null if untagged). */
export function getCompletionSpec(cmd: Command): CompletionSpec | null {
  return (cmd as CommandWithCompletion)[COMPLETION_KEY] ?? null;
}
