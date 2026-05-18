// src/completion/engine.ts
//
// Pure, tag-driven completion engine. Walks a Commander tree, reads the
// `withCompletion` tag on the resolved command, and produces candidates from
// the local completion cache and the config file (for profile names). Zero
// network. Never throws — returns [] on any error.

import type { Command } from "commander";
import { getCompletionSpec, type ResourceRef } from "../client/command-meta";
import { loadConfigSync } from "../config/store";
import { getEnvKeys, getSlice } from "./cache";
import type { Candidate, ResourceKind } from "./types";

const HIDDEN = new Set(["__complete", "__refresh-completion"]);

function commandsOf(cmd: Command): Command[] {
  return cmd.commands.filter((c) => !HIDDEN.has(c.name()));
}

function flagsOf(cmd: Command): string[] {
  const fromOptions = cmd.options.filter((o) => o.long).map((o) => o.long as string);
  const spec = getCompletionSpec(cmd);
  if (!spec?.flags) return fromOptions;
  const fromSpec = Object.keys(spec.flags);
  // Merge: spec flags may be registered without a Commander .option() call.
  const merged = new Set([...fromOptions, ...fromSpec]);
  return Array.from(merged);
}

interface Walked {
  cmd: Command;
  rest: string[];
}

/** Walk the program tree consuming subcommands; return the resolved command
 *  and the trailing tokens that were not consumed. */
function walk(program: Command, words: string[]): Walked {
  let cmd: Command = program;
  let i = 0;
  while (i < words.length) {
    const w = words[i] ?? "";
    if (w.startsWith("-")) {
      if (w.includes("=")) {
        i += 1;
        continue;
      }
      const opt = cmd.options.find((o) => o.long === w || o.short === w);
      // Best-effort heuristic: an unrecognised value-taking flag will only
      // consume 1 token here, so its value may be misread as a positional.
      i += opt && (opt.required || opt.optional) ? 2 : 1;
      continue;
    }
    const sub = commandsOf(cmd).find((c) => c.name() === w);
    if (!sub) break;
    cmd = sub;
    i += 1;
  }
  return { cmd, rest: words.slice(i) };
}

/** Read `--app` (or `--app=x`) from earlier words — env-key completion needs it. */
function findFlag(words: string[], flag: string): string | undefined {
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? "";
    if (w === flag) return words[i + 1];
    if (w.startsWith(`${flag}=`)) return w.slice(flag.length + 1);
  }
  return undefined;
}

function resourceCandidates(kind: ResourceKind, words: string[]): Candidate[] {
  if (kind === "profiles") return Object.keys(loadConfigSync().profiles).map((p) => ({ value: p }));
  if (kind === "envKeys") {
    const app = findFlag(words, "--app");
    if (!app) return [];
    return getEnvKeys(app).map((k) => ({ value: k }));
  }
  return getSlice(kind).map((e) => ({ value: e.value, desc: e.desc }));
}

function byPrefix(cands: Candidate[], current: string): Candidate[] {
  if (!current) return cands;
  return cands.filter((c) => c.value.startsWith(current));
}

function refCandidates(ref: ResourceRef, words: string[]): Candidate[] {
  if (typeof ref === "object") return ref.enum.map((v) => ({ value: v }));
  return resourceCandidates(ref, words);
}

/**
 * Compute completion candidates. Pure; never throws.
 */
export function getCompletionCandidates(
  program: Command,
  words: string[],
  current: string,
): Candidate[] {
  try {
    // 1. Flag-name completion.
    if (current.startsWith("-")) {
      const { cmd } = walk(program, words);
      return byPrefix(
        flagsOf(cmd).map((f) => ({ value: f })),
        current,
      );
    }

    // 2. Flag-value completion: last word is a value-taking long flag.
    const last = words.at(-1);
    if (last && last.startsWith("--") && !last.includes("=")) {
      const { cmd } = walk(program, words.slice(0, -1));
      const spec = getCompletionSpec(cmd);
      const ref = spec?.flags?.[last];
      if (ref) return byPrefix(refCandidates(ref, words), current);
      // Fall back to Commander-registered options that take a value.
      const opt = cmd.options.find((o) => o.long === last);
      if (opt && (opt.required || opt.optional)) {
        return [];
      }
    }

    // 3. Resolve the command.
    const { cmd, rest } = walk(program, words);
    const spec = getCompletionSpec(cmd);

    // 4. Resource arg slot.
    const positionals = rest.filter((w) => !w.startsWith("-"));
    const argSpec = spec?.args?.find((a) => a.slot === positionals.length);
    const argCands = argSpec
      ? byPrefix(resourceCandidates(argSpec.resource, words), current)
      : [];

    // 5. Subcommand slot (merged with arg candidates — `tunnel` has both
    //    subcommands and a server positional at slot 0).
    const subs = rest.length === 0 ? commandsOf(cmd).map((c) => c.name()) : [];
    const subCands = byPrefix(
      subs.map((s) => ({ value: s })),
      current,
    );

    return [...subCands, ...argCands];
  } catch {
    return [];
  }
}
