#!/usr/bin/env bun
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { registerOrg } from "./commands/org";
import { registerProfile } from "./commands/profile";
import { registerKeyring } from "./commands/keyring";
import { registerLogin } from "./commands/login";
import { registerConnectOmegaMcp } from "./commands/connect-omega-mcp";
import { registerLogout } from "./commands/logout";
import { registerWhoami } from "./commands/whoami";
import { registerServers } from "./commands/servers";
import { registerContainers } from "./commands/containers";
import { registerApps } from "./commands/apps";
import { registerDeployments } from "./commands/deployments";
import { registerLogs } from "./commands/logs";
import { registerEnv } from "./commands/env";
import { registerDomains } from "./commands/domains";
import { registerMonitors } from "./commands/monitors";
import { registerStatusPages } from "./commands/status-pages";
import { registerIncidents } from "./commands/incidents";
import { registerRepos } from "./commands/repos";
import { registerProviders } from "./commands/providers";
import { registerRegistry } from "./commands/registry";
import { registerSchedule } from "./commands/schedule";
import { registerMcp } from "./commands/mcp";
import { registerUpgrade } from "./commands/upgrade";
import { registerCompletion } from "./commands/completion";
import { registerExec } from "./commands/exec";
import { registerShell } from "./commands/shell";
import { registerTunnel } from "./commands/tunnel";
import { registerAlerts } from "./commands/alerts";
import { registerChannels } from "./commands/channels";
import { registerAudit } from "./commands/audit";
import { registerDashboard } from "./commands/dashboard";
import { bootstrap, setGlobalProfileOverride, setGlobalOrgOverride } from "./client/bootstrap";
import { commandSupportedBy } from "./client/routing";
import { maybeSpawnBackgroundRefresh } from "./completion/refresh";
import { filterCommandsByCapability } from "./client/help-filter";
import { ensureCapabilityOrExit, getRequiredCapability } from "./client/command-meta";
import { loadConfig } from "./config/store";
import { extractProfileFromArgv, resolveProfileName } from "./config/profile-resolve";
import { detectProgramName } from "./lib/program-name";

export const VERSION = pkg.version;

if (import.meta.main) {
  const PROGRAM_NAME = detectProgramName();
  const program = new Command()
    .name(PROGRAM_NAME)
    .description("Reoclo CLI")
    .version(VERSION)
    .option("-o, --output <fmt>", "output format: text|json|yaml", "text")
    .option("--no-color", "disable ANSI colors")
    .option("--quiet", "suppress non-error output")
    .option("--verbose", "log HTTP requests (tokens redacted)")
    .option(
      "--profile <name>",
      "use a named profile (overrides the active profile and $REOCLO_PROFILE)",
    )
    .option(
      "--org <slug>",
      "run against this organization for one invocation (overrides $REOCLO_ORG and the active org)",
    );

  registerOrg(program);
  registerProfile(program);
  registerKeyring(program);
  registerLogin(program);
  registerConnectOmegaMcp(program);
  registerLogout(program);
  registerWhoami(program);
  registerServers(program);
  registerContainers(program);
  registerApps(program);
  registerDeployments(program);
  registerLogs(program);
  registerEnv(program);
  registerDomains(program);
  registerMonitors(program);
  registerStatusPages(program);
  registerIncidents(program);
  registerRepos(program);
  registerProviders(program);
  registerRegistry(program);
  registerSchedule(program);
  registerMcp(program);
  registerUpgrade(program);
  registerCompletion(program);
  registerExec(program);
  registerShell(program);
  registerTunnel(program);
  registerAlerts(program);
  registerChannels(program);
  registerAudit(program);
  registerDashboard(program);

  // Load capabilities for the profile this invocation will actually use, so the
  // visible/gated command set reflects --profile / $REOCLO_PROFILE — not just the
  // config's active profile. The flag is read straight from argv since commander
  // hasn't parsed yet at this point. Best-effort: failure hides all gated
  // commands, which is correct behaviour for unauthenticated users.
  let capabilities: string[] | undefined;
  try {
    const cfg = await loadConfig();
    const gatingProfile = resolveProfileName({
      flagProfile: extractProfileFromArgv(process.argv),
      envProfile: process.env.REOCLO_PROFILE,
      activeProfile: cfg.active_profile,
    });
    capabilities = cfg.profiles[gatingProfile]?.capabilities;
  } catch {
    capabilities = undefined;
  }
  filterCommandsByCapability(program, capabilities);

  // Skip preAction for commands that don't need authentication or run before login.
  const PASSTHROUGH_COMMANDS = new Set([
    "login",
    "connect-omega-mcp",  // hidden command — IS the auth flow, so skip preAction
    "logout",
    "version",
    "help",
    "completion",
    "__complete",            // hidden completion engine — pure cache reads, never authenticates
    "__refresh-completion", // hidden background refresh — must never block on auth
    "profile",   // ls/use/rm operate on local config; no API needed
    "keyring",   // status/migrate/export operate on local stores
    "mcp",       // bootstrap happens inside the action with proper error handling
    "upgrade",   // checks get.reoclo.com; no tenant auth needed
  ]);

  function isPassthrough(actionCommand: Command): boolean {
    const leafName = actionCommand.name();
    const parentName = actionCommand.parent?.name();
    const topLevel = parentName && parentName !== PROGRAM_NAME ? parentName : leafName;
    return PASSTHROUGH_COMMANDS.has(topLevel);
  }

  program.hook("preAction", async (_thisCommand, actionCommand) => {
    // Capture the global --profile flag so bootstrap() — called with no args in
    // most command actions — honors it (then falls through to $REOCLO_PROFILE,
    // then the active profile). A command-local --profile still wins downstream
    // via opts.profile.
    setGlobalProfileOverride(actionCommand.optsWithGlobals().profile as string | undefined);
    // Same for the global --org flag → per-invocation organization override.
    setGlobalOrgOverride(actionCommand.optsWithGlobals().org as string | undefined);

    // For nested commands like `apps deploy`, actionCommand is the leaf
    // ("deploy"), and its parent is the group ("apps"). For top-level
    // commands like `whoami`, parent is the root program.
    if (isPassthrough(actionCommand)) return;

    const leafName = actionCommand.name();
    const parentName = actionCommand.parent?.name();
    const commandPath =
      parentName && parentName !== PROGRAM_NAME ? `${parentName} ${leafName}` : leafName;

    // Resolve the auth context (token + key type) without making a network call.
    const ctx = await bootstrap();

    if (!commandSupportedBy(commandPath, ctx.tokenType)) {
      const cmd = commandPath;
      const err = new Error(
        `'${cmd}' requires an organization key; automation keys can only run 'apps deploy', 'apps restart', 'exec', or 'shell'.`,
      ) as Error & { exitCode: number };
      err.exitCode = 4;
      throw err;
    }

    const verb = getRequiredCapability(actionCommand);
    if (verb !== null) {
      ensureCapabilityOrExit(capabilities, verb);
    }
  });

  program.hook("postAction", (_thisCommand, actionCommand) => {
    if (isPassthrough(actionCommand)) return;
    maybeSpawnBackgroundRefresh();
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
