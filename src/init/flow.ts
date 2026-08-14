// src/init/flow.ts
//
// Shared skills-install orchestration used by both `reoclo init` and `reoclo
// skills install` — one interactive flow (confirm → scope → harness
// multiselect → installSkills), one set of user-facing status lines, so the
// two commands never drift. `reoclo init` additionally records the outcome in
// the `.reoclo` binding (see buildProjectBinding in ../commands/init);
// `reoclo skills install` just reports it — it never touches `.reoclo`.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  type HarnessId,
  type Probes,
  type Scope,
  detectHarnesses,
  destinationsFor,
} from "./harness";
import { installSkills } from "./skills";
import { confirmPrompt, multiSelectPrompt, selectPrompt, withSpinner } from "../ui/interactive";

export interface RunSkillsInstallOpts {
  /** `-y` / non-interactive default: skip every prompt with its safe default
   *  (install, project scope, the detected harnesses). */
  assumeYes: boolean;
  /** Ask "Install reoclo skills?" first. Default true — pass `false` when the
   *  caller already has unambiguous consent and the confirm would be
   *  redundant chrome. */
  confirm?: boolean;
  /** Explicit --harness (already parsed/validated); empty means "ask / detect". */
  flagHarness: HarnessId[];
  global?: boolean;
  project?: boolean;
  /** Explicit --skills subset; undefined/empty installs every available skill. */
  requested?: string[];
  cwd?: string;
  home?: string;
  probes?: Probes;
  ref?: string;
  fetchImpl?: typeof fetch;
}

export type RunSkillsInstallOutcome =
  | { kind: "skipped" }
  | {
      kind: "installed";
      scope: Scope;
      selection: HarnessId[];
      installed: string[];
      missing: string[];
      sha?: string;
    }
  | { kind: "error"; message: string };

const defaultProbes: Probes = {
  exists: existsSync,
  which: (bin) => Boolean(Bun.which(bin)),
};

/**
 * Run the interactive (or -y/non-TTY silent) skills-install flow: optional
 * confirm, scope pick, harness multiselect (pre-checked to detected
 * harnesses), then download + place via installSkills. Prints the same
 * user-facing status lines `reoclo init` has always printed. Never throws —
 * a download/extract failure becomes an `{ kind: "error" }` outcome so each
 * caller can decide whether that's fatal (init: no, it still writes
 * `.reoclo`; `skills install`: yes, that IS the command).
 */
export async function runSkillsInstall(
  opts: RunSkillsInstallOpts,
): Promise<RunSkillsInstallOutcome> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const probes = opts.probes ?? defaultProbes;

  if (opts.confirm !== false) {
    const proceed =
      opts.assumeYes || (await confirmPrompt("Install reoclo skills?", { fallback: true }));
    if (!proceed) {
      process.stdout.write("• skipped skills\n");
      return { kind: "skipped" };
    }
  }

  const detected = detectHarnesses(cwd, home, probes);

  // Scope: this project (.agents/skills here) or all projects (~). A flag or
  // -y decides it; otherwise ask, defaulting to project.
  const scope: Scope = opts.global
    ? "global"
    : opts.project || opts.assumeYes
      ? "project"
      : await selectPrompt<Scope>(
          "Install skills for...",
          [
            { value: "project", label: "This project (.agents/skills here)" },
            { value: "global", label: "All projects (~/.agents/skills)" },
          ],
          "project",
        );

  // Harness(es): an explicit --harness wins; otherwise multi-select,
  // pre-checked to the detected harnesses (also the -y / non-TTY default).
  const selection: HarnessId[] = opts.flagHarness.length
    ? opts.flagHarness
    : opts.assumeYes
      ? detected.filter((d) => d.present).map((d) => d.id)
      : await multiSelectPrompt<HarnessId>(
          "Which agents should get the skills?",
          detected.map((d) => ({ value: d.id, label: d.label })),
          detected.filter((d) => d.present).map((d) => d.id),
        );

  const placement = destinationsFor(selection, scope, cwd, home);
  try {
    const { installed, missing, sha } = await withSpinner("Installing skills", () =>
      installSkills({
        placement,
        requested: opts.requested,
        ref: opts.ref,
        fetchImpl: opts.fetchImpl,
      }),
    );
    const where = scope === "global" ? "~/.agents/skills" : ".agents/skills";
    if (installed.length > 0) {
      process.stdout.write(
        `✓ installed ${installed.length} skill(s) into ${where}/: ${installed.join(", ")}\n`,
      );
    } else {
      process.stdout.write("• no matching skills to install\n");
    }
    if (missing.length > 0) {
      process.stderr.write(`  note: requested skill(s) not found: ${missing.join(", ")}\n`);
    }
    return { kind: "installed", scope, selection, installed, missing, sha: sha ?? undefined };
  } catch (e) {
    const message = (e as Error).message;
    process.stderr.write(`  warning: could not install skills: ${message}\n`);
    return { kind: "error", message };
  }
}
