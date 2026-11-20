// src/commands/mcp-agents.ts
import { Option, type Command } from "commander";
import {
  AGENT_IDS,
  agentEnvFromProcess,
  installAgents,
  listAgents,
  uninstallAgents,
  type AgentChange,
  type AgentEnv,
  type AgentSelector,
  type AgentStatus,
} from "../agents/agents";
import { resolveServerCommand } from "../agents/command-path";
import { AgentConfigError } from "../agents/errors";
import { assertNever } from "../agents/shared";
import { globalOutput, printObject, resolveFormat, type OutputFormat } from "../ui/output";

interface AgentFlags {
  readonly agent: AgentSelector;
  readonly command?: string;
}

function formatOf(command: Command): OutputFormat {
  let root = command;
  while (root.parent) root = root.parent;
  return resolveFormat(globalOutput(root));
}

function stateOf(agent: AgentStatus): string {
  if (!agent.installed) return "not found";
  if (agent.registered === null) return "unreadable";
  if (!agent.registered) return "not registered";
  return agent.command ? `registered (${agent.command})` : "registered";
}

function agentLines(agents: readonly AgentStatus[]): string[] {
  const width = Math.max(...agents.map((a) => a.name.length));
  return agents.map((a) => `${a.name.padEnd(width)}  ${stateOf(a)}${a.error ? `: ${a.error}` : ""}`);
}

function changeLines(change: AgentChange): string[] {
  const { name, config_path: path } = change;
  const backup = change.backup_path ? [`  Backup: ${change.backup_path}`] : [];
  switch (change.action) {
    case "installed":
      return [`Registered Reoclo with ${name} in ${path}`, ...backup];
    case "updated":
      return [`Updated the Reoclo entry for ${name} in ${path}`, ...backup];
    case "removed":
      return [`Removed Reoclo from ${name} in ${path}`, ...backup];
    case "unchanged":
      return [`${name}: no change needed in ${path}`];
    case "not-found":
      return [`${name}: not found on this Mac`];
    case "failed":
      return [`${name}: failed, ${change.problem?.message ?? "unknown error"}. The file was left as it was.`];
    default:
      return assertNever(change.action);
  }
}

function changeJson(change: AgentChange): Record<string, unknown> {
  return {
    agent: change.agent,
    name: change.name,
    action: change.action,
    config_path: change.config_path,
    backup_path: change.backup_path,
    command: change.command,
    error: change.problem ? { kind: change.problem.kind, message: change.problem.message } : null,
  };
}

function report(command: Command, changes: readonly AgentChange[], selector: AgentSelector): void {
  const fmt = formatOf(command);
  if (fmt === "text") {
    for (const line of changes.flatMap(changeLines)) process.stdout.write(`${line}\n`);
  } else {
    printObject({ results: changes.map(changeJson) }, fmt);
  }
  const failure = changes.find((c) => c.problem !== null)?.problem;
  if (failure) throw failure;
  if (selector === "all" && changes.every((c) => c.action === "not-found")) {
    throw new AgentConfigError("missing-agent", "no supported coding agent was found on this Mac");
  }
}

const agentOption = (): Option =>
  new Option("--agent <agent>", "which agent to change; all covers every agent found")
    .choices([...AGENT_IDS, "all"])
    .makeOptionMandatory();

export function registerMcpAgents(mcp: Command, locate: () => AgentEnv = agentEnvFromProcess): void {
  mcp
    .command("agents")
    .description("list the coding agents on this Mac and whether Reoclo is registered in each")
    .action((_flags: Record<string, unknown>, command: Command) => {
      const agents = listAgents(locate());
      const fmt = formatOf(command);
      if (fmt === "text") {
        for (const line of agentLines(agents)) process.stdout.write(`${line}\n`);
      } else {
        printObject({ agents }, fmt);
      }
    });

  mcp
    .command("install")
    .description("register the Reoclo MCP server with a coding agent")
    .addOption(agentOption())
    .option("--command <path>", "program the agent runs (default: the path you ran reoclo by)")
    .action((flags: AgentFlags, command: Command) => {
      const program = resolveServerCommand({
        override: flags.command,
        argv0: process.argv0,
        cwd: process.cwd(),
        which: (name) => Bun.which(name),
      });
      report(command, installAgents(flags.agent, locate(), program), flags.agent);
    });

  mcp
    .command("uninstall")
    .description("remove the Reoclo MCP server from a coding agent")
    .addOption(agentOption())
    .action((flags: AgentFlags, command: Command) => {
      report(command, uninstallAgents(flags.agent, locate()), flags.agent);
    });
}
