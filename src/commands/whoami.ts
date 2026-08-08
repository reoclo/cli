// src/commands/whoami.ts
import type { Command } from "commander";
import { bootstrap } from "../client/bootstrap";
import type { KeyType } from "../client/routing";
import type { Me } from "../client/types";

/**
 * Maps a resolved token's routing type + prefix to the human-readable label
 * shown by `reoclo whoami`. `rk_m_*` machine-user tokens route as `"tenant"`
 * (full /mcp surface, same as an OAuth user session — see routing.ts), so
 * tokenType alone can't distinguish a human from an agent credential; the
 * prefix is what does. Every other tokenType passes through unchanged
 * ("tenant" -> "user", "automation" -> "automation").
 */
export function resolveWhoamiType(tokenType: KeyType, tokenPrefix: string): string {
  if (tokenPrefix.startsWith("rk_m_")) return "machine";
  return tokenType === "tenant" ? "user" : tokenType;
}

/** Pure formatter for `reoclo whoami`. Shows the current account plus the count
 *  of OIDC-granted organizations. The full list lives in `reoclo org ls`. */
export function formatWhoamiLines(input: {
  org: string; user: string; api: string; type: string; prefix: string; orgCount: number;
}): string[] {
  return [
    `organization:  ${input.org}`,
    `user:          ${input.user}`,
    `api:           ${input.api}`,
    `type:          ${input.type}`,
    `prefix:        ${input.prefix}…***`,
    ``,
    `organizations: ${input.orgCount}`,
  ];
}

export function registerWhoami(program: Command): void {
  program
    .command("whoami")
    .description("show the authenticated identity")
    .action(async () => {
      const ctx = await bootstrap({ orgRequired: false });
      const me = await ctx.client.get<Me>("/auth/me");
      const prefix = ctx.token.slice(0, 8);
      const displayType = resolveWhoamiType(ctx.tokenType, prefix);
      for (const line of formatWhoamiLines({
        org: me.tenant_slug,
        user: me.email,
        api: ctx.api,
        type: displayType,
        prefix,
        orgCount: (me.memberships ?? []).length,
      })) {
        console.log(line);
      }
    });
}
