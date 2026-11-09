// src/hostsd/paths.ts
//
// Where the root hosts helper keeps its files. The paths are fixed: the helper
// runs as root and never takes a path from its environment.
//
// The one exception is a sandbox for tests and smoke runs. When
// REOCLO_HOSTSD_DIR is set AND the process is not root, every path moves into
// that directory. A non-root process can only write where its user can, so the
// override cannot be used to aim the helper at a system file.

import { join } from "node:path";

export interface HostsdPaths {
  /** The root-owned copy of the CLI that runs the helper. */
  binary: string;
  /** The root-owned config: allowlist, port 443 relay, installing user. */
  config: string;
  /** The LaunchDaemon plist or the systemd unit. */
  service: string;
  /** The socket the daemon talks to. Its directory is owned by the installing user, mode 0700. */
  socket: string;
  hostsFile: string;
}

export const MAC_PATHS: HostsdPaths = {
  binary: "/Library/PrivilegedHelperTools/com.reoclo.hostsd",
  config: "/Library/Application Support/Reoclo/hostsd.json",
  service: "/Library/LaunchDaemons/com.reoclo.hostsd.plist",
  socket: "/var/run/reoclo/hostsd.sock",
  hostsFile: "/etc/hosts",
};

export const LINUX_PATHS: HostsdPaths = {
  binary: "/usr/local/libexec/reoclo-hostsd",
  config: "/etc/reoclo/hostsd.json",
  service: "/etc/systemd/system/reoclo-hostsd.service",
  socket: "/run/reoclo/hostsd.sock",
  hostsFile: "/etc/hosts",
};

export const HOSTSD_LABEL = "com.reoclo.hostsd";
export const HOSTSD_UNIT = "reoclo-hostsd.service";

export function sandboxPaths(dir: string): HostsdPaths {
  return {
    binary: join(dir, "bin", "reoclo-hostsd"),
    config: join(dir, "hostsd.json"),
    service: join(dir, "service"),
    socket: join(dir, "run", "hostsd.sock"),
    hostsFile: join(dir, "hosts"),
  };
}

export function isRoot(): boolean {
  return process.getuid?.() === 0;
}

/** The sandbox directory, honored only by a process that is not root. */
export function sandboxDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = env["REOCLO_HOSTSD_DIR"];
  return dir && !isRoot() ? dir : undefined;
}

export function hostsdPaths(platform: NodeJS.Platform = process.platform): HostsdPaths {
  const dir = sandboxDir();
  if (dir) return sandboxPaths(dir);
  return platform === "darwin" ? MAC_PATHS : LINUX_PATHS;
}

/** The socket a client should dial. A client is never root, so the sandbox override always applies. */
export function hostsdSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env["REOCLO_HOSTSD_DIR"];
  return dir ? sandboxPaths(dir).socket : hostsdPaths().socket;
}
