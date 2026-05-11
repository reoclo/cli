// src/commands/profile.ts
import type { Command } from "commander";
import { loadConfig, deleteProfile, setActiveProfile } from "../config/store";

export function registerProfile(program: Command): void {
  const g = program.command("profile").description("manage named profiles");

  g.command("ls").description("list profiles").action(async () => {
    const cfg = await loadConfig();
    const rows = Object.entries(cfg.profiles).map(([n, p]) => ({
      name: n,
      active: n === cfg.active_profile ? "*" : "",
      tenant: p.tenant_slug,
      email: p.user_email,
      api: p.api_url,
      streams: p.streams_url ?? "(default)",
    }));
    console.table(rows);
  });

  g.command("use <name>").description("set active profile").action(async (name: string) => {
    await setActiveProfile(name);
    console.log(`✓ active profile: ${name}`);
  });

  g.command("rm <name>").description("remove a profile").action(async (name: string) => {
    await deleteProfile(name);
    console.log(`✓ removed: ${name}`);
  });
}
