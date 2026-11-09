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

/** Pids of the `tailscale serve` children the daemon started, so a crash cannot leave them behind. */
export function sharesFile(): string {
  return join(runDir(), "shares.json");
}

export function logFile(): string {
  return join(stateDir(), "tunneld.log");
}

/** The local certificate authority: ca.pem (public) and ca.key (mode 0600). */
export function caDir(): string {
  return join(stateDir(), "ca");
}

export function caCertFile(): string {
  return join(caDir(), "ca.pem");
}

export function caKeyFile(): string {
  return join(caDir(), "ca.key");
}
