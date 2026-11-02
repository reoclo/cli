// src/commands/keyring.ts
import type { Command } from "commander";
import { loadConfig, saveProfile } from "../config/store";
import { globalProfileFlag } from "../config/profile-resolve";
import { refreshTokenKey, refreshTokenKeyCandidates, resolveStore } from "../config/token-store";

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
    .description("move stored tokens from config.json into the OS keyring (--profile, else all)")
    .action(async (_opts: Record<string, unknown>, command: Command) => {
      const cfg = await loadConfig();
      const sel = globalProfileFlag(command);
      const names = sel ? [sel] : Object.keys(cfg.profiles);
      const kr = await resolveStore({ requireKeyring: true });
      for (const n of names) {
        const p = cfg.profiles[n];
        if (!p || (!p.token && !p.refresh_token)) continue;
        if (p.token) await kr.set(n, p.token);
        if (p.refresh_token) await kr.set(refreshTokenKey(n), p.refresh_token);
        // token_ref moves with the refresh token too: refreshes now write the
        // access token to the keyring, so reads must look there.
        await saveProfile(n, {
          ...p,
          token: undefined,
          token_ref: `keyring:reoclo-${n}`,
          refresh_token: undefined,
          refresh_token_ref: p.refresh_token ? refreshTokenKey(n) : p.refresh_token_ref,
        });
        console.log(`✓ migrated '${n}' → keyring`);
      }
    });

  g.command("export")
    .description("move stored tokens from the OS keyring into config.json (--profile, else all)")
    .action(async (_opts: Record<string, unknown>, command: Command) => {
      const cfg = await loadConfig();
      const sel = globalProfileFlag(command);
      const names = sel ? [sel] : Object.keys(cfg.profiles);
      const kr = await resolveStore({ requireKeyring: true });
      for (const n of names) {
        const p = cfg.profiles[n];
        if (!p) continue;
        const tok = await kr.get(n);
        const refreshKeys = p.refresh_token_ref
          ? refreshTokenKeyCandidates(n, p.refresh_token_ref)
          : [];
        let refresh: string | null = null;
        for (const key of refreshKeys) {
          refresh = await kr.get(key);
          if (refresh) break;
        }
        if (!tok && !refresh) continue;
        await saveProfile(n, {
          ...p,
          token: tok ?? undefined,
          token_ref: undefined,
          refresh_token: refresh ?? undefined,
          refresh_token_ref: undefined,
        });
        await kr.delete(n);
        for (const key of refreshKeys) await kr.delete(key);
        console.log(`✓ exported '${n}' → file`);
      }
    });
}
