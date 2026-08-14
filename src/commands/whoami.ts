// src/commands/whoami.ts
import type { Command } from "commander";
import { bootstrap } from "../client/bootstrap";
import { projectConfigPresent } from "../config/project-config";
import type { KeyType } from "../client/routing";
import type { Me } from "../client/types";

/**
 * Maps a resolved token's routing type to the human-readable label shown by
 * `reoclo whoami`. A pure map: "tenant" -> "user", "machine" -> "machine",
 * everything else (currently "automation") passes through unchanged.
 */
export function resolveWhoamiType(tokenType: KeyType): string {
  return tokenType === "tenant" ? "user" : tokenType;
}

/** Pure formatter for `reoclo whoami`. Shows the current account plus the count
 *  of OIDC-granted organizations; the full list lives in `reoclo org ls`. The
 *  `organization` line is emitted only when the caller is bound to one in the
 *  immediate context: pass `org: null` to omit it. The raw token prefix is
 *  never printed, because `type` already says what kind of credential this is. */
export function formatWhoamiLines(input: {
  org: string | null; user: string; api: string; type: string; orgCount: number;
}): string[] {
  const lines: string[] = [];
  if (input.org) lines.push(`organization:  ${input.org}`);
  lines.push(`user:          ${input.user}`);
  lines.push(`api:           ${input.api}`);
  lines.push(`type:          ${input.type}`);
  lines.push(``);
  lines.push(`organizations: ${input.orgCount}`);
  return lines;
}

export function registerWhoami(program: Command): void {
  program
    .command("whoami")
    .description("show the authenticated identity")
    .action(async () => {
      const ctx = await bootstrap({ orgRequired: false });
      const me = await ctx.client.get<Me>("/auth/me");
      const displayType = resolveWhoamiType(ctx.tokenType);
      // Show the org only when a `.reoclo` binds this directory to one. Otherwise
      // it's just the ambient/default org (noise here), and `reoclo org ls` lists
      // every granted org anyway.
      const org = projectConfigPresent() ? me.tenant_slug : null;
      for (const line of formatWhoamiLines({
        org,
        user: me.email,
        api: ctx.api,
        type: displayType,
        orgCount: (me.memberships ?? []).length,
      })) {
        console.log(line);
      }
    });
}
