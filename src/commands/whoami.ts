// src/commands/whoami.ts
import type { Command } from "commander";
import { bootstrap } from "../client/bootstrap";
import type { Me } from "../client/types";

export function registerWhoami(program: Command): void {
  program
    .command("whoami")
    .description("show the authenticated identity")
    .action(async () => {
      try {
        const ctx = await bootstrap();
        const me = await ctx.client.get<Me>("/auth/me");
        console.log(`tenant:  ${me.tenant_slug}`);
        console.log(`user:    ${me.email}`);
        console.log(`api:     ${ctx.api}`);
        console.log(`type:    ${ctx.tokenType}`);
        console.log(`prefix:  ${ctx.token.slice(0, 8)}…***`);
      } catch (err) {
        const code = (err as { exitCode?: number }).exitCode ?? 1;
        console.error(`Error: ${(err as Error).message}`);
        process.exit(code);
      }
    });
}
