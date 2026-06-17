// src/commands/init.ts
//
// `reoclo init` — bootstrap reoclo into a project in one command: link the
// directory to an organization (writes `.reoclo`, consumed by bootstrap()'s
// org-override seam), download the reoclo agent skills into `.claude/skills/`,
// and optionally register the reoclo MCP server in `.mcp.json`. Auth is required
// (run `reoclo login` first); the org to bind comes from the global `--org` flag
// or an interactive picker over the OAuth-granted orgs.

import type { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootstrap } from "../client/bootstrap";
import type { Me } from "../client/types";
import { loadConfig } from "../config/store";
import { installSkills } from "../init/skills";
import { mergeMcpServer } from "../init/mcp";
import { promptChoice, promptYesNo } from "../ui/prompt";

interface InitOpts {
  skills?: string | boolean; // "--skills <list>" → string; "--no-skills" → false
  mcp?: boolean;
  force?: boolean;
  yes?: boolean;
}

/**
 * Build the `.reoclo` binding to write. An org slug is only meaningful relative
 * to its backend, so when the org was resolved under a NON-active profile (e.g.
 * `reoclo --profile staging init`), the profile is pinned too — otherwise the
 * binding silently re-resolves the slug against the active profile later (and
 * slugs like "platform" can collide across staging/prod). On the active profile
 * we write only `org`, so the project still floats with the active profile.
 */
export function buildProjectBinding(opts: {
  org: string;
  profileName: string;
  activeProfile: string;
}): { profile?: string; org: string } {
  return opts.profileName === opts.activeProfile
    ? { org: opts.org }
    : { profile: opts.profileName, org: opts.org };
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
    .option("--mcp", "register the reoclo MCP server in .mcp.json")
    .option("--force", "overwrite an existing .reoclo without asking")
    .option("-y, --yes", "assume yes for prompts (non-interactive)")
    .action(async (opts: InitOpts) => {
      // bootstrap() requires auth (throws exit 3 if not) and honors the global
      // `--org` flag, so /auth/me below reflects the org the user asked for.
      const ctx = await bootstrap();
      const me = await ctx.client.get<Me>("/auth/me");
      const memberships = me.memberships ?? [];

      // Pick the org to bind. An explicit --org already resolved via bootstrap;
      // otherwise offer a picker (interactive, multi-org) or take the active org.
      const flagOrg = program.opts().org as string | undefined;
      let org = me.tenant_slug;
      if (!flagOrg && process.stdin.isTTY && memberships.length > 1) {
        const labels = memberships.map((m) => `${m.tenant_slug}  (${m.tenant_name})`);
        const activeIdx = Math.max(
          0,
          memberships.findIndex((m) => m.tenant_slug === me.tenant_slug),
        );
        const idx = await promptChoice("Which organization should this project use?", labels, activeIdx);
        org = memberships[idx]?.tenant_slug ?? me.tenant_slug;
      }

      // 1. Write the `.reoclo` binding. Pin the profile when the org was
      // resolved under a non-active profile, so the slug doesn't silently
      // re-resolve against the active profile (and a different backend) later.
      const { active_profile: activeProfile } = await loadConfig();
      const binding = buildProjectBinding({ org, profileName: ctx.profileName, activeProfile });
      const onProfile = binding.profile ? ` on profile '${binding.profile}'` : "";
      const reocloPath = join(process.cwd(), ".reoclo");
      let wroteReoclo = true;
      if (existsSync(reocloPath) && !opts.force && !opts.yes) {
        const ok = await promptYesNo(
          `.reoclo already exists — overwrite with org '${org}'${onProfile}? [y/N] `,
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

      // 2. Download skills into .claude/skills/.
      const { skip, requested } = parseSkillsOption(opts.skills);
      if (skip) {
        process.stdout.write("• skipped skills (--no-skills)\n");
      } else {
        const dest = join(process.cwd(), ".claude", "skills");
        try {
          const { installed, missing } = await installSkills({ destDir: dest, requested });
          if (installed.length > 0) {
            process.stdout.write(`✓ installed ${installed.length} skill(s) into .claude/skills/: ${installed.join(", ")}\n`);
          } else {
            process.stdout.write("• no matching skills to install\n");
          }
          if (missing.length > 0) {
            process.stderr.write(`  note: requested skill(s) not found: ${missing.join(", ")}\n`);
          }
        } catch (e) {
          process.stderr.write(`  warning: could not install skills — ${(e as Error).message}\n`);
        }
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
