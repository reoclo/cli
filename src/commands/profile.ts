// src/commands/profile.ts
import type { Command } from "commander";
import { loadConfig, deleteProfile, setActiveProfile } from "../config/store";
import { withCompletion } from "../client/command-meta";
import { resolveProfileName } from "../config/profile-resolve";
import { globalOutput, printObject, resolveFormat } from "../ui/output";

export function registerProfile(program: Command): void {
  const g = program.command("profile").description("manage named profiles");

  g.command("ls")
    .description("list profiles")
    .action(async () => {
      const cfg = await loadConfig();
      const rows = Object.entries(cfg.profiles).map(([n, p]) => ({
        name: n,
        active: n === cfg.active_profile ? "*" : "",
        organization: p.tenant_slug,
        email: p.user_email,
        api: p.api_url,
        streams: p.streams_url ?? "(default)",
      }));
      console.table(rows);
    });

  g.command("current")
    .description("show the profile this invocation resolves to (honors --profile / $REOCLO_PROFILE)")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const cfg = await loadConfig();
      const opts: Record<string, unknown> = program.opts();
      const flag = opts["profile"];
      const name = resolveProfileName({
        flagProfile: typeof flag === "string" ? flag : undefined,
        envProfile: process.env.REOCLO_PROFILE,
        activeProfile: cfg.active_profile,
      });
      const p = cfg.profiles[name];
      if (!p) {
        process.stderr.write(`profile '${name}' not found — run 'reoclo login'\n`);
        process.exit(3);
      }
      printObject(
        { profile: name, organization: p.tenant_slug, email: p.user_email, api: p.api_url },
        fmt,
      );
    });

  withCompletion(
    g
      .command("use <name>")
      .description("set active profile")
      .action(async (name: string) => {
        await setActiveProfile(name);
        const cfg = await loadConfig();
        const p = cfg.profiles[name];
        const org = p?.tenant_slug ?? "?";
        const email = p?.user_email ?? "?";
        console.log(`✓ active profile: ${name} (org: ${org}, email: ${email})`);
      }),
    { args: [{ slot: 0, resource: "profiles" }] },
  );

  withCompletion(
    g
      .command("rm <name>")
      .description("remove a profile")
      .action(async (name: string) => {
        await deleteProfile(name);
        console.log(`✓ removed: ${name}`);
      }),
    { args: [{ slot: 0, resource: "profiles" }] },
  );
}
