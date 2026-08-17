// src/init/update.ts
//
// `reoclo skills update` — refresh the skills already installed under the
// canonical `.agents/skills` root to the latest from the reoclo/skills repo,
// in place. Unlike runSkillsInstall (install / init), update never prompts and
// never adds new skills: it reads which skill dirs are already on disk and
// re-downloads exactly those. Almost every harness reads `.agents/skills`
// directly, so refreshing the canonical copies IS their update; only Claude
// Code keeps a separate `.claude/skills` symlink tree, which is re-linked when
// it is present. Like `skills install`, update never touches `.reoclo`.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type HarnessId, type Scope, destinationsFor } from "./harness";
import { installSkills } from "./skills";
import { withSpinner } from "../ui/interactive";

/** Minimal fs seam so `listInstalledSkills` stays pure and testable. */
export interface ListInstalledFs {
  readdir: (path: string) => { name: string; isDirectory: () => boolean }[];
  exists: (path: string) => boolean;
}

const defaultListFs: ListInstalledFs = {
  readdir: (p) => readdirSync(p, { withFileTypes: true }),
  exists: existsSync,
};

/**
 * The names of skills currently installed under `canonicalRoot` — every child
 * dir that holds a `SKILL.md` — sorted. Returns `[]` when the root is absent,
 * unreadable, or holds no skill dirs. Pure over the injected fs.
 */
export function listInstalledSkills(
  canonicalRoot: string,
  fs: ListInstalledFs = defaultListFs,
): string[] {
  if (!fs.exists(canonicalRoot)) return [];
  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = fs.readdir(canonicalRoot);
  } catch {
    return [];
  }
  return entries
    .filter((d) => d.isDirectory() && fs.exists(join(canonicalRoot, d.name, "SKILL.md")))
    .map((d) => d.name)
    .sort();
}

export interface RunSkillsUpdateOpts {
  global?: boolean;
  project?: boolean;
  cwd?: string;
  home?: string;
  ref?: string;
  fetchImpl?: typeof fetch;
  /** fs seam for listing installed skills (default: node:fs). */
  listFs?: ListInstalledFs;
  /** exists() used to detect an installed Claude destination (default: existsSync). */
  existsImpl?: (path: string) => boolean;
}

export type RunSkillsUpdateOutcome =
  | { kind: "none"; scope: Scope; canonicalRoot: string }
  | { kind: "updated"; scope: Scope; updated: string[]; missing: string[]; sha?: string }
  | { kind: "error"; message: string };

/**
 * Refresh the installed skills in place. Resolves the canonical root for the
 * scope, lists what is installed, and (when non-empty) re-downloads exactly
 * those skills, re-linking Claude's `.claude/skills` tree when it exists. Prints
 * the same style of status lines install does. Never throws — a download or
 * extract failure becomes `{ kind: "error" }`, mirroring runSkillsInstall — so
 * the caller decides the exit code.
 */
export async function runSkillsUpdate(
  opts: RunSkillsUpdateOpts,
): Promise<RunSkillsUpdateOutcome> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const exists = opts.existsImpl ?? existsSync;
  const scope: Scope = opts.global ? "global" : "project";
  const where = scope === "global" ? "~/.agents/skills" : ".agents/skills";

  const canonicalRoot = destinationsFor([] as HarnessId[], scope, cwd, home).canonicalRoot;
  const installed = listInstalledSkills(canonicalRoot, opts.listFs);
  if (installed.length === 0) {
    process.stdout.write(
      `• no skills installed under ${where}/. Run \`reoclo skills install\` first.\n`,
    );
    return { kind: "none", scope, canonicalRoot };
  }

  // Only Claude keeps a separate destination (`.claude/skills`). When that tree
  // exists, include claude so its per-skill symlinks are refreshed / repaired;
  // every other harness reads the canonical root directly, so refreshing the
  // canonical copies above is already their whole update.
  const base = scope === "project" ? cwd : home;
  const selection: HarnessId[] = exists(join(base, ".claude", "skills")) ? ["claude"] : [];
  const placement = destinationsFor(selection, scope, cwd, home);

  try {
    const { installed: updated, missing, sha } = await withSpinner("Updating skills", () =>
      installSkills({
        placement,
        requested: installed,
        ref: opts.ref,
        fetchImpl: opts.fetchImpl,
      }),
    );
    if (updated.length > 0) {
      process.stdout.write(
        `✓ updated ${updated.length} skill(s) in ${where}/: ${updated.join(", ")}\n`,
      );
    } else {
      process.stdout.write("• no skills to update\n");
    }
    if (missing.length > 0) {
      process.stderr.write(
        `  note: installed skill(s) no longer in reoclo/skills, left as is: ${missing.join(", ")}\n`,
      );
    }
    return { kind: "updated", scope, updated, missing, sha: sha ?? undefined };
  } catch (e) {
    const message = (e as Error).message;
    process.stderr.write(`  warning: could not update skills: ${message}\n`);
    return { kind: "error", message };
  }
}
