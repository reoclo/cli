// src/commands/logout.ts
import type { Command } from "commander";
import { loadConfig, deleteProfile } from "../config/store";
import { resolveStore } from "../config/token-store";

export function registerLogout(program: Command): void {
  program
    .command("logout")
    .description("remove stored credentials")
    .option("--profile <name>", "profile name (default: active)")
    .action(async (opts: { profile?: string }) => {
      const cfg = await loadConfig();
      const name = opts.profile ?? cfg.active_profile;
      const store = await resolveStore();
      await store.delete(name);
      await deleteProfile(name);
      console.log(`✓ logged out of '${name}'`);
    });
}
