// src/commands/whoami.ts
import type { Command } from "commander";
import { bootstrap } from "../client/bootstrap";
import type { Me } from "../client/types";

export function registerWhoami(program: Command): void {
  program
    .command("whoami")
    .description("show the authenticated identity")
    .action(async () => {
      const ctx = await bootstrap();
      const me = await ctx.client.get<Me>("/auth/me");
      console.log(`organization:  ${me.tenant_slug}`);
      console.log(`user:          ${me.email}`);
      console.log(`api:           ${ctx.api}`);
      console.log(`type:          ${ctx.tokenType}`);
      console.log(`prefix:        ${ctx.token.slice(0, 8)}…***`);

      const memberships = me.memberships ?? [];
      if (memberships.length > 0) {
        console.log(``);
        console.log(`organizations (${memberships.length}):`);
        const slugWidth = Math.max(...memberships.map((m) => m.tenant_slug.length));
        for (const m of memberships) {
          const slug = m.tenant_slug.padEnd(slugWidth);
          console.log(`  ${slug}  ${m.tenant_name}  (${m.role})`);
        }
      }
    });
}
