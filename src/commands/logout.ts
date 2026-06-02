// src/commands/logout.ts
import type { Command } from "commander";
import { loadConfig, deleteProfile } from "../config/store";
import { resolveCommandProfile } from "../config/profile-resolve";
import { resolveStore } from "../config/token-store";

export function registerLogout(program: Command): void {
  program
    .command("logout")
    // No command-local `--profile` — it is the global (root-level) flag.
    .description("remove stored credentials (defaults to the active profile)")
    .action(async (_opts: Record<string, unknown>, command: Command) => {
      const cfg = await loadConfig();
      const name = resolveCommandProfile(command, cfg.active_profile);
      const store = await resolveStore();
      await store.delete(name);
      await deleteProfile(name);
      console.log(`✓ logged out of '${name}'`);
    });
}
