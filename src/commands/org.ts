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

/** Human hint for `org current`, or null when the org is the profile's own
 *  binding. A "none" source means nothing selects an org in this directory. */
export function orgCurrentHint(source: OrgSource): string | null {
  switch (source) {
    case "flag": return "(from --org)";
    case "env": return "(from $REOCLO_ORG)";
    case "reoclo": return "(from .reoclo)";
    case "none": return "no organization selected — pass --org or run 'reoclo init'";
    case "profile": return null;
  }
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
 * to switch anymore — each command resolves its target org per-invocation
 * from `--org` / `$REOCLO_ORG` / `.reoclo`, falling back to the profile's own
 * login org (see `effectiveOrg` in `config/org-resolve.ts`). `bootstrap()`
 * mints a scoped token via the `tenant_switch` OAuth grant transparently when
 * an override is present, in-memory only, so nothing here persists a switch.
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
      // $REOCLO_ORG, and a `.reoclo` project binding — not just the stored
      // active profile, which would mislead inside a bound project tree.
      const { org, source } = effectiveOrg({
        flagOrg: program.opts().org as string | undefined,
        envOrg: process.env.REOCLO_ORG,
        projectOrg: projectOrgFor(profile.auth_kind, () => readProjectOrg()),
        profileOrg: profile.tenant_slug,
      });
      process.stdout.write(`${org}\n`);
      const hint = orgCurrentHint(source);
      if (process.stdout.isTTY && hint) process.stderr.write(`${hint}\n`);
    });
}
