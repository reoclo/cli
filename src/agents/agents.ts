// src/agents/agents.ts
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { AgentConfigError, ConfigFormatError } from "./errors";
import { readConfig, writeConfig } from "./files";
import { addJsonEntry, readJsonEntry, removeJsonEntry } from "./json-edit";
import type { RegisteredServer, StdioServer } from "./shared";
import { addTomlEntry, readTomlEntry, removeTomlEntry } from "./toml-edit";

export const AGENT_IDS = ["claude-code", "codex"] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export type AgentSelector = AgentId | "all";

/** Where to look for each agent. Injected so tests never read the real home directory. */
export interface AgentEnv {
  readonly home: string;
  readonly codexHome: string;
  readonly binDirs: readonly string[];
}

export interface AgentStatus {
  readonly id: AgentId;
  readonly name: string;
  readonly installed: boolean;
  readonly config_path: string;
  /** null when the config file could not be parsed (see `error`). */
  readonly registered: boolean | null;
  readonly command: string | null;
  readonly error: string | null;
}

export type ChangeAction = "installed" | "updated" | "removed" | "unchanged" | "not-found" | "failed";

export interface AgentChange {
  readonly agent: AgentId;
  readonly name: string;
  readonly action: ChangeAction;
  readonly config_path: string;
  readonly backup_path: string | null;
  readonly command: string | null;
  readonly problem: AgentConfigError | null;
}

const SERVER_NAME = "reoclo";
const SERVER_ARGS = ["mcp"] as const;

interface AgentSpec {
  readonly id: AgentId;
  readonly name: string;
  readonly binary: string;
  configPath(env: AgentEnv): string;
  markers(env: AgentEnv): readonly string[];
  read(text: string): RegisteredServer | null;
  add(text: string | undefined, server: StdioServer): string;
  remove(text: string): string;
}

const SPECS: readonly AgentSpec[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    binary: "claude",
    configPath: (env) => join(env.home, ".claude.json"),
    markers: (env) => [join(env.home, ".claude.json"), join(env.home, ".claude")],
    read: (text) => readJsonEntry(text, SERVER_NAME),
    add: (text, server) => addJsonEntry(text, SERVER_NAME, server),
    remove: (text) => removeJsonEntry(text, SERVER_NAME),
  },
  {
    id: "codex",
    name: "Codex",
    binary: "codex",
    configPath: (env) => join(env.codexHome, "config.toml"),
    markers: (env) => [env.codexHome],
    read: (text) => readTomlEntry(text, SERVER_NAME),
    add: (text, server) => addTomlEntry(text, SERVER_NAME, server),
    remove: (text) => removeTomlEntry(text, SERVER_NAME),
  },
];

export function agentEnvFromProcess(): AgentEnv {
  const home = homedir();
  const onPath = (process.env["PATH"] ?? "").split(delimiter).filter((dir) => dir !== "");
  const binDirs = [
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    join(home, ".bun", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".volta", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...onPath,
  ];
  return { home, codexHome: process.env["CODEX_HOME"] || join(home, ".codex"), binDirs: [...new Set(binDirs)] };
}

function isInstalled(spec: AgentSpec, env: AgentEnv): boolean {
  return spec.markers(env).some((path) => existsSync(path)) || env.binDirs.some((dir) => existsSync(join(dir, spec.binary)));
}

function problemFor(path: string, e: unknown): AgentConfigError {
  if (e instanceof AgentConfigError) return e;
  if (e instanceof ConfigFormatError) {
    const verb = e.kind === "unparsable" ? "parse" : "edit";
    return new AgentConfigError(e.kind, `cannot ${verb} ${path}: ${e.message}`);
  }
  throw e;
}

function statusOf(spec: AgentSpec, env: AgentEnv): AgentStatus {
  const config_path = spec.configPath(env);
  const base = { id: spec.id, name: spec.name, installed: isInstalled(spec, env), config_path };
  try {
    const text = readConfig(config_path);
    const entry = text === undefined ? null : spec.read(text);
    return { ...base, registered: entry !== null, command: entry?.command ?? null, error: null };
  } catch (e) {
    return { ...base, registered: null, command: null, error: problemFor(config_path, e).message };
  }
}

export function listAgents(env: AgentEnv): AgentStatus[] {
  return SPECS.map((spec) => statusOf(spec, env));
}

function select(selector: AgentSelector): readonly AgentSpec[] {
  return SPECS.filter((spec) => selector === "all" || spec.id === selector);
}

function changeFor(spec: AgentSpec, env: AgentEnv, command: string | null): AgentChange {
  return {
    agent: spec.id,
    name: spec.name,
    action: "unchanged",
    config_path: spec.configPath(env),
    backup_path: null,
    command,
    problem: null,
  };
}

function notFound(spec: AgentSpec, change: AgentChange, selector: AgentSelector): AgentChange {
  const problem = selector === "all" ? null : new AgentConfigError("missing-agent", `${spec.name} was not found on this Mac`);
  return { ...change, action: "not-found", problem };
}

function apply(
  selector: AgentSelector,
  env: AgentEnv,
  command: string | null,
  edit: (spec: AgentSpec, text: string | undefined) => { next: string; action: ChangeAction } | null,
): AgentChange[] {
  return select(selector).map((spec) => {
    const change = changeFor(spec, env, command);
    if (!isInstalled(spec, env)) return notFound(spec, change, selector);
    try {
      const text = readConfig(change.config_path);
      const edited = edit(spec, text);
      if (edited === null || edited.next === text) return change;
      return { ...change, action: edited.action, backup_path: writeConfig(change.config_path, edited.next) };
    } catch (e) {
      return { ...change, action: "failed", problem: problemFor(change.config_path, e) };
    }
  });
}

export function installAgents(selector: AgentSelector, env: AgentEnv, command: string): AgentChange[] {
  const server: StdioServer = { command, args: SERVER_ARGS };
  return apply(selector, env, command, (spec, text) => {
    const registered = text !== undefined && spec.read(text) !== null;
    return { next: spec.add(text, server), action: registered ? "updated" : "installed" };
  });
}

export function uninstallAgents(selector: AgentSelector, env: AgentEnv): AgentChange[] {
  return apply(selector, env, null, (spec, text) => (text === undefined ? null : { next: spec.remove(text), action: "removed" }));
}
