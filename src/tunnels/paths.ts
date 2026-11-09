// src/tunnels/paths.ts
//
// Where the tunnel daemon keeps its files. Everything lives under
// <configDir>/tunnels so a launchd or systemd job (which has no XDG_CONFIG_HOME)
// resolves the same directory as an interactive shell.

import { join } from "node:path";
import { configDir } from "../config/paths";

export function stateDir(): string {
  return join(configDir(), "tunnels");
}

export function tunnelsFile(): string {
  return join(stateDir(), "tunnels.yaml");
}

/** Directory holding the socket and pid file. Mode 0700. */
export function runDir(): string {
  return join(stateDir(), "run");
}

export function socketPath(): string {
  return join(runDir(), "tunneld.sock");
}

export function pidFile(): string {
  return join(runDir(), "tunneld.pid");
}

export function logFile(): string {
  return join(stateDir(), "tunneld.log");
}
