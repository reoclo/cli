// src/commands/keyring.ts
import type { Command } from "commander";
import { loadConfig, saveProfile } from "../config/store";
import { resolveStore } from "../config/token-store";
import { FileStore } from "../config/keyring/file";

export function registerKeyring(program: Command): void {
  const g = program.command("keyring").description("OS keyring management");

  g.command("status").action(async () => {
    const cfg = await loadConfig();
    for (const [name, p] of Object.entries(cfg.profiles)) {
      const where = p.token_ref ? p.token_ref : p.token ? "file:config.json" : "(no token)";
      console.log(`${name}\t${where}`);
    }
  });

  g.command("migrate")
    .description("move stored tokens from config.json into the OS keyring")
    .option("--profile <name>", "profile to migrate (default: all with file token)")
    .action(async (opts: { profile?: string }) => {
      const cfg = await loadConfig();
      const names = opts.profile ? [opts.profile] : Object.keys(cfg.profiles);
      const kr = await resolveStore({ requireKeyring: true });
      const file = new FileStore();
      for (const n of names) {
        const tok = await file.get(n);
        if (!tok) continue;
        await kr.set(n, tok);
        await file.delete(n);
        const p = cfg.profiles[n];
        if (!p) continue;
        await saveProfile(n, { ...p, token: undefined, token_ref: `keyring:reoclo-${n}` });
        console.log(`✓ migrated '${n}' → keyring`);
      }
    });

  g.command("export")
    .description("move stored tokens from the OS keyring into config.json")
    .option("--profile <name>", "profile to export (default: all with keyring token)")
    .action(async (opts: { profile?: string }) => {
      const cfg = await loadConfig();
      const names = opts.profile ? [opts.profile] : Object.keys(cfg.profiles);
      const kr = await resolveStore({ requireKeyring: true });
      for (const n of names) {
        const tok = await kr.get(n);
        if (!tok) continue;
        const p = cfg.profiles[n];
        if (!p) continue;
        await saveProfile(n, { ...p, token: tok, token_ref: undefined });
        await kr.delete(n);
        console.log(`✓ exported '${n}' → file`);
      }
    });
}
