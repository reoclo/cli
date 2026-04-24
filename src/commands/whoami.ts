// src/commands/whoami.ts
import type { Command } from "commander";
import { getActiveProfile } from "../config/store";

export function registerWhoami(program: Command): void {
  program
    .command("whoami")
    .description("show active profile identity")
    .action(async () => {
      const p = await getActiveProfile();
      if (!p) {
        console.error("Error: not authenticated. Run 'reoclo login'.");
        process.exit(3);
      }
      console.log(`tenant:  ${p.tenant_slug}`);
      console.log(`user:    ${p.user_email}`);
      console.log(`api:     ${p.api_url}`);
      console.log(`type:    ${p.token_type}`);
    });
}
