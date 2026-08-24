// src/commands/profile.ts
import type { Command } from "commander";
import { loadConfig, deleteProfile, setActiveProfile, type ProfileRecord } from "../config/store";
import { withCompletion } from "../client/command-meta";
import { resolveProfileName } from "../config/profile-resolve";
import { globalOutput, printList, printObject, resolveFormat } from "../ui/output";

/**
 * Describe a profile's credential in one word.
 *
 * `auth_kind` is checked before `token_type` on purpose: a device-flow login
 * mints an automation-prefixed token, so an OAuth profile carries
 * `token_type: "automation"` too, and reading token_type first would label
 * every logged-in user an automation key. An expired access token is only a
 * note, because the next command refreshes it from the stored refresh token.
 */
export function authSummary(p: ProfileRecord, now: number): string {
  if (p.auth_kind === "oauth") {
    const expiresAt = p.access_token_expires_at
      ? Date.parse(p.access_token_expires_at)
      : Number.NaN;
    if (Number.isNaN(expiresAt)) return "oauth";
    return expiresAt > now ? "oauth" : "oauth (expired)";
  }
  if (p.token_type === "automation") return "automation key";
  return "api key";
}

/** Rows for `profile ls`, active profile first, then alphabetical. */
export function profileRows(
  profiles: Record<string, ProfileRecord>,
  activeProfile: string,
  now: number,
): Array<Record<string, unknown>> {
  return Object.entries(profiles)
    .sort(([a], [b]) => {
      if (a === activeProfile) return -1;
      if (b === activeProfile) return 1;
      return a.localeCompare(b);
    })
    .map(([name, p]) => ({
      active: name === activeProfile ? "*" : "",
      name,
      organization: p.tenant_slug,
      email: p.user_email,
      auth: authSummary(p, now),
      api: p.api_url,
    }));
}

export function registerProfile(program: Command): void {
  const g = program.command("profile").description("manage named profiles");

  g.command("ls")
    .description("list profiles")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const cfg = await loadConfig();
      const rows = profileRows(cfg.profiles, cfg.active_profile, Date.now());
      if (rows.length === 0) {
        if (fmt === "text") {
          process.stderr.write("no profiles yet. Run 'reoclo login'.\n");
          return;
        }
        printList(rows, ["name"], fmt);
        return;
      }
      printList(
        rows,
        [
          { key: "active", label: " " },
          { key: "name", label: "PROFILE" },
          { key: "organization", label: "ORGANIZATION" },
          { key: "email", label: "EMAIL" },
          { key: "auth", label: "AUTH" },
          { key: "api", label: "API" },
        ],
        fmt,
      );
      if (fmt === "text") {
        process.stdout.write(
          `\n* = active. Switch with 'reoclo profile use <name>', or override one command with --profile.\n`,
        );
      }
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
        process.stderr.write(`profile '${name}' not found. Run 'reoclo login'.\n`);
        process.exit(3);
      }
      printObject(
        {
          profile: name,
          organization: p.tenant_slug,
          email: p.user_email,
          auth: authSummary(p, Date.now()),
          api: p.api_url,
          streams: p.streams_url ?? "(derived from api)",
        },
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
