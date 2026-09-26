// src/completion/engine.ts
//
// Pure, tag-driven completion engine. Walks a Commander tree, reads the
// `withCompletion` tag on the resolved command, and produces candidates from
// the local completion cache and the config file (for profile names). Zero
// network. Never throws — returns [] on any error.

import type { Command } from "commander";
import { getCompletionSpec, type ResourceRef } from "../client/command-meta";
import { loadConfigSync } from "../config/store";
import { extractProfileFromArgv, resolveProfileName } from "../config/profile-resolve";
import { extractOrgFromArgv, resolveOrgOverride } from "../config/org-resolve";
import { projectOrgFor, readProjectOrg } from "../config/project-config";
import { getEnvKeys, getSlice, setActiveOrg } from "./cache";
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

/** Find an option by long/short name on `cmd` or any of its ancestors. */
function optionOnChain(cmd: Command, name: string): Command["options"][number] | undefined {
  for (let c: Command | null = cmd; c; c = c.parent) {
    const opt = c.options.find((o) => o.long === name || o.short === name);
    if (opt) return opt;
  }
  return undefined;
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
      // A flag can belong to the command reached so far OR to any ancestor:
      // the root's globals (`--org`, `--profile`, `-o`) are valid after a
      // subcommand too, and a global typed there must still consume its
      // value. Best-effort heuristic: an unrecognised value-taking flag will
      // only consume 1 token here, so its value may be misread as a positional.
      const opt = optionOnChain(cmd, w);
      i += opt && (opt.required || opt.optional) ? 2 : 1;
      continue;
    }
    // Match aliases as well as names, so a line typed with an equivalent verb
    // ("servers list ") still resolves to the command carrying the completion
    // tag. Candidates are still emitted under the canonical name only.
    const sub = commandsOf(cmd).find((c) => c.name() === w || c.aliases().includes(w));
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
 * Scope the completion cache to the org this completion line targets: `--org`
 * typed on the line, else $REOCLO_ORG, else the `.reoclo` binding of the
 * working directory (OAuth profiles only, as in bootstrap). The profile
 * (`--profile` on the line, else $REOCLO_PROFILE, else the active profile) is
 * part of the key. With no org there are no candidates: the profile's login
 * org is never a source. Runs in the zero-network __complete process, where
 * bootstrap() never ran. Never throws.
 */
function scopeCacheToOrg(words: string[]): void {
  try {
    const cfg = loadConfigSync();
    const name = resolveProfileName({
      flagProfile: extractProfileFromArgv(words),
      envProfile: process.env.REOCLO_PROFILE,
      activeProfile: cfg.active_profile,
    });
    const slug = resolveOrgOverride({
      flagOrg: extractOrgFromArgv(words),
      envOrg: process.env.REOCLO_ORG,
      projectOrg: projectOrgFor(cfg.profiles[name]?.auth_kind, () => readProjectOrg()),
    });
    setActiveOrg(name, slug);
  } catch {
    setActiveOrg(undefined, undefined);
  }
}

/** Long and short names of every value-taking flag visible at `cmd`: the root
 *  program's globals, the command's own options, and its completion-spec flags. */
function valueFlagsOf(
  program: Command,
  cmd: Command,
  spec: ReturnType<typeof getCompletionSpec>,
): Set<string> {
  const out = new Set<string>();
  for (const o of [...program.options, ...cmd.options]) {
    if (!(o.required || o.optional)) continue;
    if (o.long) out.add(o.long);
    if (o.short) out.add(o.short);
  }
  for (const f of Object.keys(spec?.flags ?? {})) out.add(f);
  return out;
}

/** The positional tokens of `rest`: flags are dropped, and so is the token that
 *  follows a value-taking flag (`--org acme`), unless it was written `--org=acme`. */
function positionalsOf(rest: string[], valueFlags: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i] ?? "";
    if (w.startsWith("-")) {
      if (!w.includes("=") && valueFlags.has(w)) i += 1;
      continue;
    }
    out.push(w);
  }
  return out;
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
    scopeCacheToOrg(words);

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

    // 4. Resource arg slot. A value-taking flag typed after the command (a
    // global `--org acme` / `--profile x`, or the command's own `--app x`)
    // must not have its value counted as a positional.
    const positionals = positionalsOf(rest, valueFlagsOf(program, cmd, spec));
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
