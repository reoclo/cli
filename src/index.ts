#!/usr/bin/env bun
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { registerProfile } from "./commands/profile";
import { registerKeyring } from "./commands/keyring";
import { registerLogin } from "./commands/login";
import { registerLogout } from "./commands/logout";
import { registerWhoami } from "./commands/whoami";
import { registerServers } from "./commands/servers";
import { registerApps } from "./commands/apps";
import { registerDeployments } from "./commands/deployments";
import { registerLogs } from "./commands/logs";
import { registerEnv } from "./commands/env";
import { registerDomains } from "./commands/domains";

export const VERSION = pkg.version;

if (import.meta.main) {
  const program = new Command()
    .name("reoclo")
    .description("Reoclo CLI")
    .version(VERSION)
    .option("-o, --output <fmt>", "output format: text|json|yaml", "text")
    .option("--no-color", "disable ANSI colors")
    .option("--quiet", "suppress non-error output")
    .option("--verbose", "log HTTP requests (tokens redacted)");

  registerProfile(program);
  registerKeyring(program);
  registerLogin(program);
  registerLogout(program);
  registerWhoami(program);
  registerServers(program);
  registerApps(program);
  registerDeployments(program);
  registerLogs(program);
  registerEnv(program);
  registerDomains(program);

  try {
    await program.parseAsync(process.argv);
  } catch (e) {
    const err = e as { message?: string; hint?: string; exitCode?: number };
    process.stderr.write(`Error: ${err.message ?? String(e)}\n`);
    if (err.hint) process.stderr.write(`  ${err.hint}\n`);
    process.exit(err.exitCode ?? 1);
  }
}
