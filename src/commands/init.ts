// src/commands/init.ts
//
// `reoclo init` — bootstrap reoclo into a project in one command: link the
// directory to an organization (writes `.reoclo`, consumed by bootstrap()'s
// org-override seam), install the reoclo agent skills for the developer's agent
// harness(es) (canonical `.agents/skills/` + a Claude Code symlink), and
// optionally register the reoclo MCP server in `.mcp.json`. Auth is required
// (run `reoclo login` first); the org to bind comes from the global `--org` flag
// or an interactive picker over the OAuth-granted orgs.

import type { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootstrap } from "../client/bootstrap";
import type { Me } from "../client/types";
import { loadConfig } from "../config/store";
import { PROJECT_CONFIG_VERSION } from "../config/project-config";
import { HARNESSES, type HarnessId, type Scope } from "../init/harness";
import { runSkillsInstall } from "../init/flow";
import { mergeMcpServer } from "../init/mcp";
import { confirmPrompt, selectPrompt } from "../ui/interactive";

interface InitOpts {
  skills?: string | boolean; // "--skills <list>" → string; "--no-skills" → false
  harness?: string;          // "--harness <list>" → comma-separated harness ids
  global?: boolean;          // "--global" → install skills for all projects (~)
  project?: boolean;         // "--project" → install skills for this project only
  mcp?: boolean;
  force?: boolean;
  yes?: boolean;
}

/** The `skills` block recorded in `.reoclo` after an install: which ref/sha, when,
 *  which harness `targets` were installed for, and the install `scope`. */
export interface SkillsMeta {
  ref: string;
  sha?: string;
  installed_at?: string;
  targets?: string[];
  scope?: Scope;
}

/**
 * Build the `.reoclo` binding to write. An org slug is only meaningful relative
 * to its backend, so when the org was resolved under a NON-active profile (e.g.
 * `reoclo --profile staging init`), the profile is pinned too — otherwise the
 * binding silently re-resolves the slug against the active profile later (and
 * slugs like "platform" can collide across staging/prod). On the active profile
 * we write only `org`, so the project still floats with the active profile.
 * Every binding also records the `.reoclo` schema `version`, and (when skills
 * were installed) the `skills` block (ref/sha/installed_at plus the harness
 * `targets` and `scope`) so a later `init` or `doctor` can tell whether the
 * installed skills are stale and re-sync the same destinations.
 */
export function buildProjectBinding(opts: {
  org: string;
  profileName: string;
  activeProfile: string;
  skills?: SkillsMeta;
}): {
  profile?: string;
  org: string;
  version: number;
  skills?: SkillsMeta;
} {
  const base = opts.profileName === opts.activeProfile
    ? { org: opts.org, version: PROJECT_CONFIG_VERSION }
    : { profile: opts.profileName, org: opts.org, version: PROJECT_CONFIG_VERSION };
  return opts.skills ? { ...base, skills: opts.skills } : base;
}

/**
 * Parse the `--harness` option into a validated list of harness ids. Splits a
 * comma list, trims each entry, and drops any id not in {@link HARNESSES} (so a
 * typo installs nowhere rather than silently). Absent/empty → `[]`, meaning
 * "fall back to detection / the multi-select".
 */
export function parseHarnessOption(value?: string): HarnessId[] {
  if (!value) return [];
  const known = new Set<HarnessId>(HARNESSES.map((h) => h.id));
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is HarnessId => known.has(s as HarnessId));
}

/** Resolve the `--skills` / `--no-skills` option into a concrete intent. */
export function parseSkillsOption(skills: string | boolean | undefined): {
  skip: boolean;
  requested?: string[];
} {
  if (skills === false) return { skip: true };
  if (typeof skills === "string") {
    return { skip: false, requested: skills.split(",").map((s) => s.trim()).filter(Boolean) };
  }
  return { skip: false };
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("link this project to an organization and install reoclo skills")
    .option("--skills <list>", "comma-separated skills to install (default: all)")
    .option("--no-skills", "skip installing skills")
    .option("--harness <list>", "comma-separated agent harnesses to install skills for (e.g. claude,codex)")
    .option("--global", "install skills for all projects (~/.agents/skills)")
    .option("--project", "install skills for this project only (default)")
    .option("--mcp", "register the reoclo MCP server in .mcp.json")
    .option("--force", "overwrite an existing .reoclo without asking")
    .option("-y, --yes", "assume yes for prompts (non-interactive)")
    .action(async (opts: InitOpts) => {
      // bootstrap() requires auth (throws exit 3 if not) and honors the global
      // `--org` flag, so /auth/me below reflects the org the user asked for.
      // orgRequired: false — init IS how a directory gets bound to an org, so
      // it must run before any org selection exists.
      const ctx = await bootstrap({ orgRequired: false });
      const me = await ctx.client.get<Me>("/auth/me");
      const memberships = me.memberships ?? [];

      // Pick the org to bind. An explicit --org already resolved via bootstrap;
      // otherwise offer a picker (multi-org only). selectPrompt returns the
      // initial value (the active org) verbatim on a non-TTY, so a scripted run
      // still binds the active org without prompting.
      const flagOrg = program.opts().org as string | undefined;
      let org = me.tenant_slug;
      if (!flagOrg && memberships.length > 1) {
        const options = memberships.map((m) => ({
          value: m.tenant_slug,
          label: `${m.tenant_slug}  (${m.tenant_name})`,
        }));
        const initial =
          memberships.find((m) => m.tenant_slug === me.tenant_slug)?.tenant_slug ?? me.tenant_slug;
        org = await selectPrompt("Which organization should this project use?", options, initial);
      }

      // 1. Install skills first, so the installed head SHA is known by the time
      // the `.reoclo` binding is written below. The flow is harness-aware and
      // confirm-gated (shared with `reoclo skills install` via runSkillsInstall):
      // it asks whether to install, for which scope, and which agent harness(es).
      // Under -y or a non-TTY every prompt no-ops to a safe default (install,
      // project scope, the detected harnesses) so scripted and CI runs never
      // block. Explicit flags always win over a prompt.
      const assumeYes = opts.yes === true;
      const flagHarness = parseHarnessOption(opts.harness);
      const { skip, requested } = parseSkillsOption(opts.skills);
      let skillsMeta: SkillsMeta | undefined;
      if (skip) {
        process.stdout.write("• skipped skills (--no-skills)\n");
      } else {
        const outcome = await runSkillsInstall({
          assumeYes,
          flagHarness,
          global: opts.global,
          project: opts.project,
          requested,
        });
        if (outcome.kind === "installed") {
          // sha may be undefined (best-effort GitHub lookup failed): the skills
          // block is still written, just without a sha, so a later `doctor` sees
          // "installed" rather than a false "up to date". `targets`/`scope` let a
          // later re-sync target the same destinations.
          skillsMeta = {
            ref: "main",
            sha: outcome.sha,
            installed_at: new Date().toISOString(),
            targets: outcome.selection,
            scope: outcome.scope,
          };
        }
      }

      // 2. Write the `.reoclo` binding. Pin the profile when the org was
      // resolved under a non-active profile, so the slug doesn't silently
      // re-resolve against the active profile (and a different backend) later.
      const { active_profile: activeProfile } = await loadConfig();
      const binding = buildProjectBinding({
        org,
        profileName: ctx.profileName,
        activeProfile,
        skills: skillsMeta,
      });
      const onProfile = binding.profile ? ` on profile '${binding.profile}'` : "";
      const reocloPath = join(process.cwd(), ".reoclo");
      let wroteReoclo = true;
      if (existsSync(reocloPath) && !opts.force && !opts.yes) {
        const ok = await confirmPrompt(
          `.reoclo already exists. Overwrite with org '${org}'${onProfile}?`,
          { initialValue: false, fallback: false },
        );
        if (!ok) {
          wroteReoclo = false;
          process.stdout.write("• kept the existing .reoclo\n");
        }
      }
      if (wroteReoclo) {
        writeFileSync(reocloPath, `${JSON.stringify(binding, null, 2)}\n`);
        process.stdout.write(`✓ linked this project to '${org}'${onProfile} (.reoclo)\n`);
      }

      // 3. Optionally register the reoclo MCP server.
      if (opts.mcp) {
        const mcpPath = join(process.cwd(), ".mcp.json");
        let existing: unknown = null;
        if (existsSync(mcpPath)) {
          try {
            existing = JSON.parse(readFileSync(mcpPath, "utf8"));
          } catch {
            process.stderr.write("  warning: .mcp.json was not valid JSON — rewriting it\n");
          }
        }
        writeFileSync(mcpPath, `${JSON.stringify(mergeMcpServer(existing), null, 2)}\n`);
        process.stdout.write("✓ registered the reoclo MCP server in .mcp.json\n");
      }

      process.stdout.write(
        `\nDone. Commands run here now target '${org}'${onProfile}. Try: reoclo whoami\n`,
      );
    });
}
