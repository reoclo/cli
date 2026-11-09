// src/tunnels/service.ts
//
// Start the daemon at login: a launchd agent on macOS, a systemd user unit on
// Linux. The file contents are pure functions so they can be tested; install
// and uninstall do the file and service-manager work.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { daemonCommand } from "./control-client";
import { logFile, stateDir } from "./paths";

export const LAUNCHD_LABEL = "com.reoclo.tunneld";
export const SYSTEMD_UNIT = "reoclo-tunneld.service";

export interface ServiceSpec {
  /** The program and its arguments. */
  command: string[];
  logPath: string;
  /** Environment to carry into the service (REOCLO_CONFIG_DIR, PATH). */
  env: Record<string, string>;
}

export function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The launchd agent. It restarts the daemon after a crash but not after a clean exit, so `daemon stop` sticks. */
export function launchdPlist(spec: ServiceSpec): string {
  const args = spec.command.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const env = Object.entries(spec.env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(spec.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.logPath)}</string>
</dict>
</plist>
`;
}

export function systemdQuote(arg: string): string {
  return /^[A-Za-z0-9_\-./:=@%+]+$/.test(arg) ? arg : `"${arg.replace(/(["\\])/g, "\\$1")}"`;
}

/** The systemd user unit. */
export function systemdUnit(spec: ServiceSpec): string {
  const env = Object.entries(spec.env)
    .map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`)
    .join("\n");
  return `[Unit]
Description=Reoclo tunnel daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${spec.command.map(systemdQuote).join(" ")}
${env}
Restart=on-failure
RestartSec=5
StandardOutput=append:${spec.logPath}
StandardError=append:${spec.logPath}

[Install]
WantedBy=default.target
`;
}

/**
 * The path to put in the service file. A Homebrew install runs from a symlink
 * (/opt/homebrew/bin/reoclo) that points into a versioned Cellar directory, and
 * the Cellar path disappears on upgrade. Prefer the PATH entry that resolves to
 * the running binary.
 */
export function stableBinaryPath(
  execPath: string,
  pathEnv: string,
  deps: { exists: (p: string) => boolean; realpath: (p: string) => string } = {
    exists: existsSync,
    realpath: realpathSync,
  },
): string {
  if (!execPath.includes("/Cellar/")) return execPath;
  const real = deps.realpath(execPath);
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "reoclo");
    if (deps.exists(candidate) && deps.realpath(candidate) === real) return candidate;
  }
  return execPath;
}

export function serviceSpec(): ServiceSpec {
  const { cmd, args } = daemonCommand();
  const env: Record<string, string> = { PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin" };
  const configDir = process.env["REOCLO_CONFIG_DIR"];
  if (configDir) env["REOCLO_CONFIG_DIR"] = configDir;
  const program = args.length === 3 ? stableBinaryPath(cmd, env["PATH"] ?? "") : cmd;
  return { command: [program, ...args], logPath: logFile(), env };
}

export function launchdPlistPath(home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function systemdUnitPath(home: string = homedir()): string {
  return join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
}

function run(cmd: string, args: string[]): { ok: boolean; output: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

export interface ServiceResult {
  file: string;
  message: string;
}

export function installService(): ServiceResult {
  const spec = serviceSpec();
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  if (platform() === "darwin") {
    const file = launchdPlistPath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, launchdPlist(spec));
    const target = `gui/${process.getuid?.() ?? 0}`;
    run("launchctl", ["bootout", `${target}/${LAUNCHD_LABEL}`]);
    const r = run("launchctl", ["bootstrap", target, file]);
    if (!r.ok) throw new Error(`launchctl bootstrap failed: ${r.output}`);
    return { file, message: `installed ${file} and loaded it with launchctl` };
  }
  if (platform() === "linux") {
    const file = systemdUnitPath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, systemdUnit(spec));
    run("systemctl", ["--user", "daemon-reload"]);
    const r = run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
    if (!r.ok) throw new Error(`systemctl enable failed: ${r.output}`);
    return { file, message: `installed ${file} and enabled it with systemctl --user` };
  }
  throw new Error(`starting the daemon at login is not supported on ${platform()}`);
}

export function uninstallService(): ServiceResult {
  if (platform() === "darwin") {
    const file = launchdPlistPath();
    run("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`]);
    const existed = existsSync(file);
    rmSync(file, { force: true });
    return { file, message: existed ? `removed ${file}` : "no launchd agent was installed" };
  }
  if (platform() === "linux") {
    const file = systemdUnitPath();
    run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    const existed = existsSync(file);
    rmSync(file, { force: true });
    run("systemctl", ["--user", "daemon-reload"]);
    return { file, message: existed ? `removed ${file}` : "no systemd unit was installed" };
  }
  throw new Error(`starting the daemon at login is not supported on ${platform()}`);
}
