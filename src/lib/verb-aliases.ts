// src/lib/verb-aliases.ts
//
// Equivalent spellings for the CLI's collection verbs, applied across the whole
// command tree after registration.
//
// Two problems this solves. First, callers (agents especially) reach for the
// long form (`list`, `delete`) before the short one, and get an "unknown
// command" error on a surface that does support the operation. Second, the
// CLI's own groups are split between the spellings: `servers ls` but `channels
// list`, `domains rm` but `channels delete`. Registering each verb under every
// equivalent spelling makes a group answer to whichever one the caller tries,
// no matter which spelling that group's author picked.

import type { Command } from "commander";

/** Verb → the other spellings the same command should also answer to. */
export const VERB_ALIASES: Readonly<Record<string, readonly string[]>> = {
  ls: ["list"],
  list: ["ls"],
  rm: ["delete", "remove"],
  delete: ["rm", "remove"],
  remove: ["rm", "delete"],
};

/** Every name a subcommand of `parent` already answers to. */
function takenNames(parent: Command): Set<string> {
  const taken = new Set<string>();
  for (const child of parent.commands) {
    taken.add(child.name());
    for (const alias of child.aliases()) taken.add(alias);
  }
  return taken;
}

/**
 * Register every equivalent spelling of each subcommand's verb, recursively.
 *
 * A spelling already claimed by a sibling, as its name or as an alias it was
 * given deliberately, is skipped. A real command always beats a generated
 * alias. Returns the number of aliases added, which the tests assert on.
 */
export function applyVerbAliases(root: Command): number {
  let added = 0;
  const taken = takenNames(root);
  for (const child of root.commands) {
    for (const alias of VERB_ALIASES[child.name()] ?? []) {
      if (taken.has(alias)) continue;
      child.alias(alias);
      taken.add(alias);
      added += 1;
    }
    added += applyVerbAliases(child);
  }
  return added;
}
