// src/hostsd/install.ts
//
// Install and remove the root hosts helper. `reoclo hosts setup` re-runs the
// CLI under sudo as `__hostsd-install`, which lands here. The helper runs from a
// root-owned copy of the CLI binary: running the user-writable, Homebrew-managed
// binary as root would let anything that can write to it become root.

import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { realRunner, shellWords, type CommandRunner } from "../tunnels/command-runner";
import { assertValidSuffix, replaceBlock } from "../tunnels/hosts-block";
import { systemdQuote, xml } from "../tunnels/service";
import { rewriteHostsFile } from "./hosts-file";
import type { HostsdConfig } from "./main";
import { HOSTSD_LABEL, HOSTSD_UNIT, type HostsdPaths } from "./paths";

export const HOSTSD_LOG = "/var/log/reoclo-hostsd.log";

export function hostsdLaunchdPlist(binary: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${HOSTSD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(binary)}</string>
    <string>__hostsd</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${HOSTSD_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${HOSTSD_LOG}</string>
</dict>
</plist>
`;
}

export function hostsdSystemdUnit(binary: string): string {
  return `[Unit]
Description=Reoclo hosts helper
After=network.target

[Service]
Type=simple
ExecStart=${systemdQuote(binary)} __hostsd
Restart=always
RestartSec=5
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
`;
}

export interface InstallOptions {
  uid: number;
  allowSuffixes: string[];
  port443: boolean;
  relayPort?: number;
  /** The CLI binary to copy. */
  sourceBinary: string;
  platform: NodeJS.Platform;
  paths: HostsdPaths;
  run?: CommandRunner;
  /** Make the installed files root-owned. Off in tests, which run unprivileged. */
  chownRoot?: boolean;
  /** Waits between launchd retries. Tests replace it. */
  sleep?: (ms: number) => Promise<void>;
  /** Resolves once the helper answers. Absent in a sandbox, where no service starts. */
  waitUntilUp?: () => Promise<void>;
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallError";
  }
}

export function buildConfig(o: Pick<InstallOptions, "uid" | "allowSuffixes" | "port443" | "relayPort">): HostsdConfig {
  if (!Number.isInteger(o.uid) || o.uid < 0) throw new InstallError(`invalid --uid ${String(o.uid)}`);
  for (const s of o.allowSuffixes) assertValidSuffix(s);
  if (o.port443 && o.relayPort === undefined) throw new InstallError("--port-443 needs --relay-port");
  return {
    version: 1,
    uid: o.uid,
    allow_suffixes: [...new Set(o.allowSuffixes)].sort(),
    port_443: o.port443,
    ...(o.port443 && o.relayPort !== undefined ? { relay_port: o.relayPort } : {}),
  };
}

async function must(run: CommandRunner, cmd: string, args: string[]): Promise<void> {
  const r = await run(cmd, args);
  if (r.code !== 0) throw new InstallError(`${shellWords(cmd, args)} failed: ${(r.stderr || r.stdout).trim()}`);
}

const BOOTSTRAP_ATTEMPTS = 8;
const BOOTSTRAP_RETRY_MS = 250;
const UNLOAD_WAIT_ATTEMPTS = 120;
const UNLOAD_WAIT_MS = 250;

/**
 * `launchctl bootout` returns before launchd has stopped the old helper, which once took
 * about 5 s. Wait (up to 30 s) until launchd no longer knows the service, so the bootstrap
 * after it does not race a service that is still loaded.
 */
async function waitForUnload(run: CommandRunner, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < UNLOAD_WAIT_ATTEMPTS; attempt++) {
    if ((await run("launchctl", ["print", `system/${HOSTSD_LABEL}`])).code !== 0) return;
    await sleep(UNLOAD_WAIT_MS);
  }
}

/** `launchctl bootout` returns before launchd has finished, so a bootstrap straight after it can fail. */
async function bootstrapLaunchd(run: CommandRunner, service: string, sleep: (ms: number) => Promise<void>): Promise<void> {
  const args = ["bootstrap", "system", service];
  for (let attempt = 1; attempt < BOOTSTRAP_ATTEMPTS; attempt++) {
    if ((await run("launchctl", args)).code === 0) return;
    await sleep(BOOTSTRAP_RETRY_MS);
  }
  await must(run, "launchctl", args);
}

const HELPER_WAIT_ATTEMPTS = 80;
const HELPER_WAIT_MS = 250;

/**
 * The helper takes a couple of seconds to start. Whoever ran the install asks it
 * for its status straight after, so the install must not return before it answers.
 */
export async function waitForHelper(
  status: () => Promise<unknown>,
  sleep: (ms: number) => Promise<void> = Bun.sleep,
): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < HELPER_WAIT_ATTEMPTS; attempt++) {
    try {
      await status();
      return;
    } catch (err) {
      last = err;
      await sleep(HELPER_WAIT_MS);
    }
  }
  const why = last instanceof Error ? last.message : String(last);
  throw new InstallError(`the hosts helper was installed but did not answer: ${why}`);
}

function putFile(path: string, content: string, mode: number, root: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  if (root) chownSync(path, 0, 0);
}

export async function installHostsd(o: InstallOptions): Promise<string[]> {
  if (o.platform !== "darwin" && o.platform !== "linux") throw new InstallError(`the hosts helper is not supported on ${o.platform}`);
  const run = o.run ?? realRunner;
  const root = o.chownRoot ?? false;
  const config = buildConfig(o);
  const { paths } = o;

  mkdirSync(dirname(paths.binary), { recursive: true });
  const tmp = `${paths.binary}.new`;
  copyFileSync(o.sourceBinary, tmp);
  chmodSync(tmp, 0o755);
  if (root) chownSync(tmp, 0, 0);
  renameSync(tmp, paths.binary);
  putFile(paths.config, JSON.stringify(config, null, 2) + "\n", 0o600, root);

  if (o.platform === "darwin") {
    putFile(paths.service, hostsdLaunchdPlist(paths.binary), 0o644, root);
    await run("launchctl", ["bootout", `system/${HOSTSD_LABEL}`]);
    await waitForUnload(run, o.sleep ?? Bun.sleep);
    await bootstrapLaunchd(run, paths.service, o.sleep ?? Bun.sleep);
  } else {
    putFile(paths.service, hostsdSystemdUnit(paths.binary), 0o644, root);
    await must(run, "systemctl", ["daemon-reload"]);
    await must(run, "systemctl", ["enable", HOSTSD_UNIT]);
    await must(run, "systemctl", ["restart", HOSTSD_UNIT]);
  }
  await o.waitUntilUp?.();
  return [
    `copied the CLI to ${paths.binary}`,
    `wrote ${paths.config}`,
    `registered ${paths.service}`,
    config.allow_suffixes.length > 0 ? `allowed suffixes: ${config.allow_suffixes.join(", ")}` : "allowed suffixes: .localhost only",
    config.port_443 ? `port 443 relays to ${String(config.relay_port)} while nothing else answers on 443` : "port 443 relay: off",
  ];
}

export async function uninstallHostsd(o: Pick<InstallOptions, "platform" | "paths" | "run">): Promise<string[]> {
  const run = o.run ?? realRunner;
  const { paths } = o;
  const done: string[] = [];
  if (o.platform === "darwin") {
    await run("launchctl", ["bootout", `system/${HOSTSD_LABEL}`]);
  } else if (o.platform === "linux") {
    await run("systemctl", ["disable", "--now", HOSTSD_UNIT]);
  }
  for (const file of [paths.service, paths.binary, paths.config]) {
    if (existsSync(file)) {
      rmSync(file, { force: true });
      done.push(`removed ${file}`);
    }
  }
  rmSync(dirname(paths.socket), { recursive: true, force: true });
  if (o.platform === "linux") await run("systemctl", ["daemon-reload"]);
  if (rewriteHostsFile(paths.hostsFile, (text) => replaceBlock(text, [])).changed) {
    done.push(`removed the reoclo block from ${paths.hostsFile}`);
  }
  return done.length > 0 ? done : ["the hosts helper was not installed"];
}
