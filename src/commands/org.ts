// src/commands/org.ts
import type { Command } from "commander";
import { bootstrap } from "../client/bootstrap";
import type { Me, OrgMembership } from "../client/types";
import { getActiveProfile } from "../config/store";
import { effectiveOrg } from "../config/org-resolve";
import type { OrgSource } from "../config/org-resolve";
import { projectOrgFor, readProjectOrg } from "../config/project-config";
import { globalOutput, printList, resolveFormat } from "../ui/output";
import type { OutputFormat } from "../ui/output";
import { formatRole } from "../ui/format-role";

/** Human hint for `org current`. A "none" source means nothing selects an
 *  org in this directory. */
export function orgCurrentHint(source: OrgSource): string | null {
  switch (source) {
    case "flag": return "(from --org)";
    case "env": return "(from $REOCLO_ORG)";
    case "reoclo": return "(from .reoclo)";
    case "none": return "no organization selected: pass --org or run 'reoclo init'";
  }
}

/**
 * Pure output for `org current`: what to write to stdout and stderr. When
 * nothing selects an org ("none"), stdout stays empty — there is no org to
 * print — and the hint explaining how to select one goes to stderr. Otherwise
 * the org itself goes to stdout, and its source hint goes to stderr only when
 * attached to a TTY (scripts piping stdout shouldn't see it).
 */
export function orgCurrentOutput(
  source: OrgSource,
  org: string,
  isTty: boolean,
): { stdout: string; stderr: string } {
  if (source === "none") return { stdout: "", stderr: `${orgCurrentHint("none")}\n` };
  const hint = orgCurrentHint(source);
  return { stdout: `${org}\n`, stderr: isTty && hint ? `${hint}\n` : "" };
}

/**
 * Build the rows for `org ls`. The role is humanized for human/text output but
 * kept RAW for machine output (`-o json` / `-o yaml`) so scripts still match on
 * the server value (e.g. "tenant_admin").
 */
export function buildOrgRows(
  memberships: OrgMembership[],
  activeTenantId: string,
  fmt: OutputFormat,
): Array<{ active: string; slug: string; name: string; role: string }> {
  return memberships.map((m) => ({
    active: m.tenant_id === activeTenantId ? "*" : "",
    slug: m.tenant_slug,
    name: m.tenant_name,
    role: fmt === "text" ? formatRole(m.role) : m.role,
  }));
}

/**
 * `reoclo org` — select or list organizations within the OAuth-granted set.
 *
 * The CLI is single-org-per-request by design: every request carries a JWT
 * with one `tenant_id`. OAuth consent records WHICH orgs the user authorized
 * for this client in `granted_tenants`. There is no persistent "active org"
 * to switch anymore — an org-scoped command resolves its target per-invocation
 * from `--org` / `$REOCLO_ORG` / `.reoclo` and, under the OAuth-profile
 * explicit-org policy, errors via `orgSelectionError` when none is set (it
 * never falls back to the profile's login org). `bootstrap()` mints a scoped
 * token via the `tenant_switch` OAuth grant transparently when an override is
 * present, in-memory only, so nothing here persists a switch. Identity-only
 * commands like `org ls`/`org current` themselves opt out of that requirement
 * (`orgRequired: false`) since they don't need a target org to run.
 */
export function registerOrg(program: Command): void {
  const g = program
    .command("org")
    .description("select or list organizations within the OAuth-granted set");

  g.command("ls")
    .description("list organizations available to the current credential")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap({ orgRequired: false });
      const me = await ctx.client.get<Me>("/auth/me");
      const memberships = me.memberships ?? [];
      const rows = buildOrgRows(memberships, me.tenant_id, fmt);
      printList(
        rows as unknown as Array<Record<string, unknown>>,
        [
          { key: "active", label: " " },
          { key: "slug", label: "SLUG" },
          { key: "name", label: "NAME" },
          { key: "role", label: "ROLE" },
        ],
        fmt,
      );
    });

  g.command("current")
    .description("print the organization the CLI will target in this directory")
    .action(async () => {
      const profile = await getActiveProfile();
      if (!profile) {
        process.stderr.write("not authenticated — run 'reoclo login'\n");
        process.exit(3);
      }
      // Report the EFFECTIVE org for this directory — honoring `--org`,
      // $REOCLO_ORG, and a `.reoclo` project binding. There is no fallback to
      // the profile's login org: under the explicit-org policy, an unbound
      // directory has NO target org, matching what a scoped command would do.
      const { org, source } = effectiveOrg({
        flagOrg: program.opts().org as string | undefined,
        envOrg: process.env.REOCLO_ORG,
        projectOrg: projectOrgFor(profile.auth_kind, () => readProjectOrg()),
      });
      const { stdout, stderr } = orgCurrentOutput(source, org, Boolean(process.stdout.isTTY));
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    });
}
