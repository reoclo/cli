#!/usr/bin/env bun
import { basename } from "node:path";
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
import { registerMcp } from "./commands/mcp";
import { registerUpgrade } from "./commands/upgrade";
import { registerCompletion } from "./commands/completion";
import { registerExec } from "./commands/exec";
import { registerShell } from "./commands/shell";
import { bootstrap } from "./client/bootstrap";
import { commandSupportedBy } from "./client/routing";
import { filterCommandsByCapability } from "./client/help-filter";
import { ensureCapabilityOrExit, getRequiredCapability } from "./client/command-meta";
import { getActiveProfile } from "./config/store";

export const VERSION = pkg.version;

// Detect how the user invoked us. We accept `rc` as a short alias for
// `reoclo`; everything else falls back to "reoclo" so the tool always
// has a stable name in help output and error messages.
function detectProgramName(): string {
  const argv0 = process.argv[0] ?? "";
  const name = basename(argv0).toLowerCase().replace(/\.exe$/, "");
  return name === "rc" ? "rc" : "reoclo";
}

if (import.meta.main) {
  const PROGRAM_NAME = detectProgramName();
  const program = new Command()
    .name(PROGRAM_NAME)
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
  registerMcp(program);
  registerUpgrade(program);
  registerCompletion(program);
  registerExec(program);
  registerShell(program);

  // Load capabilities from the active profile (best-effort — failure hides all gated commands,
  // which is correct behaviour for unauthenticated users).
  let capabilities: string[] | undefined;
  try {
    const profile = await getActiveProfile();
    capabilities = profile?.capabilities;
  } catch {
    capabilities = undefined;
  }
  filterCommandsByCapability(program, capabilities);

  // Skip preAction for commands that don't need authentication or run before login.
  const PASSTHROUGH_COMMANDS = new Set([
    "login",
    "logout",
    "version",
    "help",
    "completion",
    "__complete", // hidden completion engine — pure cache reads, never authenticates
    "profile",   // ls/use/rm operate on local config; no API needed
    "keyring",   // status/migrate/export operate on local stores
    "mcp",       // bootstrap happens inside the action with proper error handling
    "upgrade",   // checks get.reoclo.com; no tenant auth needed
  ]);

  program.hook("preAction", async (_thisCommand, actionCommand) => {
    // For nested commands like `apps deploy`, actionCommand is the leaf
    // ("deploy"), and its parent is the group ("apps"). For top-level
    // commands like `whoami`, parent is the root program.
    const leafName = actionCommand.name();
    const parentName = actionCommand.parent?.name();
    const topLevel = parentName && parentName !== PROGRAM_NAME ? parentName : leafName;

    if (PASSTHROUGH_COMMANDS.has(topLevel)) return;

    // Resolve the auth context (token + key type) without making a network call.
    const ctx = await bootstrap();

    if (!commandSupportedBy(leafName, ctx.tokenType)) {
      const cmd = parentName && parentName !== PROGRAM_NAME ? `${parentName} ${leafName}` : leafName;
      const err = new Error(
        `'${cmd}' requires a tenant key; automation keys can only run deploy/restart/exec/shell.`,
      ) as Error & { exitCode: number };
      err.exitCode = 4;
      throw err;
    }

    const verb = getRequiredCapability(actionCommand);
    if (verb !== null) {
      ensureCapabilityOrExit(capabilities, verb);
    }
  });

  try {
    await program.parseAsync(process.argv);
  } catch (e) {
    const err = e as { message?: string; hint?: string; exitCode?: number };
    process.stderr.write(`Error: ${err.message ?? String(e)}\n`);
    if (err.hint) process.stderr.write(`  ${err.hint}\n`);
    process.exit(err.exitCode ?? 1);
  }
}
