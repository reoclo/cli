// src/completion/engine.ts
//
// Pure completion engine. Walks a Commander tree to compute candidate
// completions for the current cursor position. Has zero side effects beyond
// the cache reads in resources.ts (which themselves never block on the
// network). Easy to unit-test by passing a fake Command.

import type { Command } from "commander";
import {
  getCachedApps,
  getCachedDeployments,
  getCachedDomains,
  getCachedEnvKeys,
  getCachedServers,
} from "./resources";

// Resource arg → resource type mapping. Keys are full command paths joined by
// space ("apps deploy", "exec"); the value describes which positional slot to
// fill and where the candidates come from. Slot is 0-indexed *after* the
// last subcommand in the path.
type ResourceKind = "apps" | "servers" | "deployments" | "domains" | "envKeys";

interface ResourceSlot {
  slot: number;
  kind: ResourceKind;
}

const RESOURCE_SLOTS: Record<string, ResourceSlot> = {
  "apps get": { slot: 0, kind: "apps" },
  "apps deploy": { slot: 0, kind: "apps" },
  "apps logs": { slot: 0, kind: "apps" },
  "apps restart": { slot: 0, kind: "apps" },
  "servers get": { slot: 0, kind: "servers" },
  "servers metrics": { slot: 0, kind: "servers" },
  "exec": { slot: 0, kind: "servers" },
  "shell": { slot: 0, kind: "servers" },
  "deployments get": { slot: 0, kind: "deployments" },
  "deployments logs": { slot: 0, kind: "deployments" },
  "domains verify": { slot: 0, kind: "domains" },
  "env rm": { slot: 0, kind: "envKeys" },
  "env get": { slot: 0, kind: "envKeys" },
};

// Per-command flag → dynamic resource. When the user types `cmd --flag <TAB>`,
// the value gets completed from the corresponding cached resource list.
const FLAG_RESOURCES: Record<string, Record<string, ResourceKind>> = {
  "logs tail": { "--server": "servers" },
  "env ls": { "--app": "apps" },
  "env set": { "--app": "apps" },
  "env rm": { "--app": "apps" },
  "env get": { "--app": "apps" },
  "deployments ls": { "--app": "apps" },
};

// Per-command flag → fixed candidate set. Useful for enums and small closed
// vocabularies where the API doesn't change the valid values.
const STATIC_FLAG_VALUES: Record<string, Record<string, string[]>> = {
  "logs tail": {
    "--source": ["container", "system", "docker_daemon", "runner", "kernel", "auth"],
  },
  "exec": {
    "--scope": ["host", "rootless"],
  },
  "upgrade": {
    "--channel": ["stable", "beta", "dev"],
  },
  "completion": {
    "--shell": ["bash", "zsh", "fish"],
  },
};

// Commands that should never appear in completion output. These are hidden
// (e.g. internal helpers) or otherwise inappropriate for tab-completion
// surfaces.
const HIDDEN_COMMANDS = new Set(["__complete"]);

function commandsOf(cmd: Command): Command[] {
  return cmd.commands.filter((c) => !HIDDEN_COMMANDS.has(c.name()));
}

function subcommandNames(cmd: Command): string[] {
  return commandsOf(cmd).map((c) => c.name());
}

function flagsOf(cmd: Command): string[] {
  // Long flags only — these are what tab completion is most useful for.
  // Short flags (`-o`) are usually too terse to want as candidates after `-`.
  const out: string[] = [];
  for (const o of cmd.options) {
    if (o.long) out.push(o.long);
  }
  return out;
}

/**
 * Walk the program tree following the supplied words until we reach a leaf
 * subcommand or an argument slot. Returns the resolved command and the words
 * that were *not* consumed (i.e. trailing positional args / partial input
 * for the current slot).
 */
function walk(program: Command, words: string[]): { cmd: Command; rest: string[]; path: string[] } {
  let cmd: Command = program;
  const path: string[] = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i] ?? "";
    if (w.startsWith("-")) {
      // Skip flags and (best-effort) their values. We don't have full
      // knowledge of which flags take values, so consume one extra token if
      // it doesn't look like a flag itself.
      if (w.includes("=")) {
        i += 1;
        continue;
      }
      // If the option is known and takes an arg, skip its value.
      const opt = cmd.options.find((o) => o.long === w || o.short === w);
      if (opt && (opt.required || opt.optional)) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    const sub = commandsOf(cmd).find((c) => c.name() === w);
    if (!sub) break;
    cmd = sub;
    path.push(w);
    i += 1;
  }
  return { cmd, rest: words.slice(i), path };
}

/**
 * Find the value of `--app` (or `--app=...`) anywhere in the prior words,
 * for env-key lookups that need an app context.
 */
function findAppOption(words: string[]): string | undefined {
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? "";
    if (w === "--app") {
      return words[i + 1];
    }
    if (w.startsWith("--app=")) {
      return w.slice("--app=".length);
    }
  }
  return undefined;
}

function resourceCandidates(kind: ResourceKind, words: string[]): string[] {
  switch (kind) {
    case "apps":
      return getCachedApps();
    case "servers":
      return getCachedServers();
    case "deployments":
      return getCachedDeployments();
    case "domains":
      return getCachedDomains();
    case "envKeys": {
      const appId = findAppOption(words);
      if (!appId) return [];
      return getCachedEnvKeys(appId);
    }
  }
}

function filterByPrefix(candidates: string[], current: string): string[] {
  if (!current) return candidates;
  return candidates.filter((c) => c.startsWith(current));
}

/**
 * Compute completion candidates for a given Commander program, the words
 * that have been typed so far (after `reoclo`), and the partial current
 * word the user is completing.
 *
 * Pure function. Never throws on bad input — returns [] on any error.
 */
export function getCompletionCandidates(
  program: Command,
  words: string[],
  current: string,
): string[] {
  try {
    // 1. Flag completion: when the user has typed `--`, just emit the flags
    //    of the deepest command we can resolve.
    if (current.startsWith("-")) {
      const { cmd } = walk(program, words);
      return filterByPrefix(flagsOf(cmd), current);
    }

    // 1.5 Flag-value completion: if the last typed word is a long flag that
    //     takes a value, complete the value (static enum or dynamic resource).
    //     Skip --flag=value (already terminated) and boolean flags.
    const lastWord = words.at(-1);
    if (lastWord && lastWord.startsWith("--") && !lastWord.includes("=")) {
      const wordsBeforeFlag = words.slice(0, -1);
      const { cmd, path } = walk(program, wordsBeforeFlag);
      const opt = cmd.options.find((o) => o.long === lastWord);
      if (opt && (opt.required || opt.optional)) {
        const pathKey = path.join(" ");
        const staticVals = STATIC_FLAG_VALUES[pathKey]?.[lastWord];
        if (staticVals) return filterByPrefix(staticVals, current);
        const flagRes = FLAG_RESOURCES[pathKey]?.[lastWord];
        if (flagRes) {
          return filterByPrefix(resourceCandidates(flagRes, words), current);
        }
        return [];
      }
    }

    // 2. Resolve the current command from the words.
    const { cmd, rest, path } = walk(program, words);

    // 3. Resource arg slot: check if the resolved command has a registered
    //    resource slot at the current positional index.
    const pathKey = path.join(" ");
    const slot = RESOURCE_SLOTS[pathKey];
    if (slot) {
      // `rest` is the positional args (and unrecognised tokens) after the
      // last consumed subcommand. Count *non-flag* tokens to find the
      // current positional index. The "current" word is what the user is
      // completing right now and is not part of `words`, so its slot is
      // restPositionals.length.
      const restPositionals = rest.filter((w) => !w.startsWith("-"));
      if (restPositionals.length === slot.slot) {
        return filterByPrefix(resourceCandidates(slot.kind, words), current);
      }
    }

    // 4. Subcommand slot: emit the children of the resolved command.
    const subs = subcommandNames(cmd);
    if (subs.length > 0 && rest.length === 0) {
      return filterByPrefix(subs, current);
    }

    // 5. Top-level fallback at empty input.
    if (words.length === 0) {
      return filterByPrefix(subcommandNames(program), current);
    }

    return [];
  } catch {
    return [];
  }
}
