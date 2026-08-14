// src/commands/skills.ts
//
// `reoclo skills` — manage the reoclo agent skills independently of `init`.
//
//   `skills install` runs the same harness-aware, confirm-gated flow `init`
//   runs (see ../init/flow.ts's runSkillsInstall, shared by both commands) but
//   never writes `.reoclo` — that binding, and the decision of which org a
//   project targets, is init's job, not skills install's. Useful to re-sync
//   skills, add a harness, or install into a directory that's already linked.
//
//   `skills list` shows every skill available in the reoclo/skills repo and
//   marks which ones are already sitting in the resolved canonical
//   `.agents/skills` root (project or global) — no download/install, no
//   auth, purely informational.
//
// Neither subcommand talks to the reoclo API, so `skills` is registered as a
// preAction passthrough in index.ts (same reasoning as `init`/`mcp`).

import type { Command } from "commander";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HARNESSES, type HarnessId, type Scope, destinationsFor } from "../init/harness";
import { runSkillsInstall } from "../init/flow";
import { fetchAvailableSkills } from "../init/skills";
import { parseHarnessOption, parseSkillsOption } from "./init";
import { withCompletion } from "../client/command-meta";
import { globalOutput, printList, resolveFormat } from "../ui/output";

interface SkillsInstallOpts {
  harness?: string; // "--harness <list>" → comma-separated harness ids
  global?: boolean; // "--global" → install skills for all projects (~)
  project?: boolean; // "--project" → install skills for this project only
  skills?: string; // "--skills <list>" → comma-separated skills to install
  yes?: boolean;
}

interface SkillsListOpts {
  global?: boolean;
  project?: boolean;
}

/** Resolve the `--global`/`--project` pair into a Scope (default: project). */
function resolveScope(opts: { global?: boolean; project?: boolean }): Scope {
  return opts.global ? "global" : "project";
}

export function registerSkills(program: Command): void {
  const skills = program.command("skills").description("manage reoclo agent skills");

  withCompletion(
    skills
      .command("install")
      .description("install reoclo agent skills into this project or globally")
      .option(
        "--harness <list>",
        "comma-separated agent harnesses to install skills for (e.g. claude,codex)",
      )
      .option("--global", "install skills for all projects (~/.agents/skills)")
      .option("--project", "install skills for this project only (default)")
      .option("--skills <list>", "comma-separated skills to install (default: all)")
      .option("-y, --yes", "assume yes for prompts (non-interactive)")
      .action(async (opts: SkillsInstallOpts) => {
        const assumeYes = opts.yes === true;
        const flagHarness = parseHarnessOption(opts.harness);
        const { requested } = parseSkillsOption(opts.skills);
        const outcome = await runSkillsInstall({
          assumeYes,
          flagHarness,
          global: opts.global,
          project: opts.project,
          requested,
        });
        if (outcome.kind === "error") {
          process.exit(1);
        }
      }),
    { flags: { "--harness": { enum: HARNESSES.map((h) => h.id) } } },
  );

  skills
    .command("list")
    .description("list the reoclo agent skills available, and which are already installed")
    .option("--global", "check the global skills root (~/.agents/skills)")
    .option("--project", "check this project's skills root (default)")
    .action(async (opts: SkillsListOpts) => {
      const scope = resolveScope(opts);
      const canonicalRoot = destinationsFor(
        [] as HarnessId[],
        scope,
        process.cwd(),
        homedir(),
      ).canonicalRoot;

      const { available, cleanup } = await fetchAvailableSkills({});
      cleanup();

      const fmt = resolveFormat(globalOutput(program));
      if (available.length === 0) {
        if (fmt === "text") process.stdout.write("No skills found in reoclo/skills.\n");
        else printList([], [{ key: "name", label: "SKILL" }], fmt);
        return;
      }

      const rows = available.map((name) => ({
        name,
        installed: existsSync(join(canonicalRoot, name, "SKILL.md")) ? "yes" : "no",
      }));
      const where = scope === "global" ? "~/.agents/skills" : ".agents/skills";
      if (fmt === "text") {
        process.stdout.write(`Skills installed under ${where}/ are marked "yes":\n\n`);
      }
      printList(
        rows,
        [
          { key: "name", label: "SKILL" },
          { key: "installed", label: "INSTALLED" },
        ],
        fmt,
      );
    });
}
