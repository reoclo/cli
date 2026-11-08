// src/client/server-setup.ts
//
// Builds the shell command that runs setup/setup.sh (served at
// `<install url>/setup`) on a server, for `servers add` and `servers harden`.
// Same options and validation rules as the dashboard's builder in core
// (web/src/lib/server-setup.ts). Every value placed in a command is validated
// here first, because the command is run by a remote root shell.

import { badUsage } from "../util/parse-flag";

/**
 * - "ssh": run by the CLI over a non-interactive SSH session. Fails instead of
 *   prompting for a sudo password, and a failed download fails the pipeline.
 * - "paste": pasted into a shell by a person, so sudo may prompt.
 * - "cloud-init": a user-data script that runs as root on first boot.
 */
export type SetupTarget = "ssh" | "paste" | "cloud-init";

export interface HardenOptions {
  adminUser: string;
  installUrl: string;
  /** SSH lockdown only: no firewall, fail2ban or automatic updates. */
  sshOnly?: boolean;
  firewallAllow: string[];
  trustedIps: string[];
  check?: boolean;
}

export interface SetupOptions extends Omit<HardenOptions, "sshOnly"> {
  token: string;
  gatewayUrl: string | null;
  hostname?: string;
  harden: boolean;
}

export interface SshDestination {
  user?: string;
  host: string;
}

const ADMIN_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const PORT_RE = /^(\d{1,5})(?::(\d{1,5}))?(?:\/(tcp|udp))?$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;
const IPV6_RE = /^[0-9a-fA-F:]+(?:\/(\d{1,3}))?$/;
const HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const INSTALL_URL_RE = /^https?:\/\/[A-Za-z0-9.:/_-]+$/;
// Neither part may start with "-", or ssh would read it as an option.
const SSH_USER_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
const SSH_HOST_RE = /^[A-Za-z0-9.:_][A-Za-z0-9.:_-]*$/;

function splitList(values: string[]): string[] {
  return values.flatMap((v) => v.split(/[\s,]+/)).filter((v) => v.length > 0);
}

function isValidPort(entry: string): boolean {
  const m = PORT_RE.exec(entry);
  if (!m) return false;
  const lo = Number(m[1]);
  const hi = m[2] === undefined ? null : Number(m[2]);
  if (lo < 1 || lo > 65535) return false;
  if (hi === null) return true;
  // ufw requires a protocol on ranges, and ranges must ascend.
  return hi <= 65535 && hi > lo && m[3] !== undefined;
}

function isValidIpOrCidr(entry: string): boolean {
  const v4 = IPV4_RE.exec(entry);
  if (v4) {
    const octetsOk = [v4[1], v4[2], v4[3], v4[4]].every((o) => Number(o) <= 255);
    return octetsOk && (v4[5] === undefined || Number(v4[5]) <= 32);
  }
  const v6 = IPV6_RE.exec(entry);
  return v6 !== null && entry.includes(":") && (v6[1] === undefined || Number(v6[1]) <= 128);
}

export function parseFirewallPorts(values: string[]): string[] {
  const entries = splitList(values);
  const invalid = entries.filter((e) => !isValidPort(e));
  if (invalid.length > 0) {
    throw badUsage(
      `invalid --firewall-allow: ${invalid.join(", ")} (use 8080, 8080/tcp or 9000:9100/udp)`,
    );
  }
  return entries;
}

export function parseTrustedIps(values: string[]): string[] {
  const entries = splitList(values);
  const invalid = entries.filter((e) => !isValidIpOrCidr(e));
  if (invalid.length > 0) {
    throw badUsage(
      `invalid --trusted-ip: ${invalid.join(", ")} (use 203.0.113.7 or 203.0.113.0/24)`,
    );
  }
  return entries;
}

export function parseAdminUser(user: string): string {
  if (!ADMIN_USER_RE.test(user) || user === "root") {
    throw badUsage(
      `invalid --user: '${user}' (a Linux username other than root: lowercase letters, digits, - and _)`,
    );
  }
  return user;
}

export function parseHostname(hostname: string): string {
  if (!HOSTNAME_RE.test(hostname)) throw badUsage(`invalid --hostname: '${hostname}'`);
  return hostname;
}

export function parseInstallUrl(url: string): string {
  if (!INSTALL_URL_RE.test(url)) throw badUsage(`invalid --install-url: '${url}'`);
  return url.replace(/\/+$/, "");
}

export function parseSshDestination(raw: string): SshDestination {
  const at = raw.lastIndexOf("@");
  const user = at === -1 ? undefined : raw.slice(0, at);
  const host = at === -1 ? raw : raw.slice(at + 1);
  if ((user !== undefined && !SSH_USER_RE.test(user)) || !SSH_HOST_RE.test(host)) {
    throw badUsage(`invalid --ssh: '${raw}' (expected [user@]host)`);
  }
  return { user, host };
}

export function formatSshDestination(dest: SshDestination): string {
  return dest.user ? `${dest.user}@${dest.host}` : dest.host;
}

/** The admin user setup should use: an explicit --user, else the non-root user
 *  you log in as (EC2's `ubuntu` or `admin`), else setup's default. */
export function resolveAdminUser(explicit: string | undefined, login: string | undefined): string {
  if (explicit !== undefined) return parseAdminUser(explicit);
  if (login !== undefined && login !== "root") return parseAdminUser(login);
  return "ubuntu";
}

function fail2banIgnoreArg(trustedIps: string[], target: SetupTarget): string | null {
  if (target === "cloud-init") {
    return trustedIps.length > 0 ? `--fail2ban-ignore ${trustedIps.join(",")}` : null;
  }
  // The remote shell expands this to the operator's own SSH address before sudo
  // drops SSH_CLIENT, so setup never bans the person running it.
  return `--fail2ban-ignore "\${SSH_CLIENT%% *}${trustedIps.map((ip) => ` ${ip}`).join("")}"`;
}

function hardeningArgs(
  firewallAllow: string[],
  trustedIps: string[],
  target: SetupTarget,
): string[] {
  const args = ["--harden"];
  if (firewallAllow.length > 0) args.push(`--firewall-allow ${firewallAllow.join(",")}`);
  const ignore = fail2banIgnoreArg(trustedIps, target);
  if (ignore) args.push(ignore);
  return args;
}

function renderCommand(installUrl: string, args: string[], target: SetupTarget): string {
  const body = args.map((a) => `  ${a}`).join(" \\\n");
  if (target === "cloud-init") {
    return [
      "#!/bin/bash",
      "# Reoclo server setup: runs once, as root, on first boot.",
      `curl -fsSL ${installUrl}/setup | bash -s -- \\`,
      body,
    ].join("\n");
  }
  const detect = `if command -v curl >/dev/null 2>&1; then GET="curl -fsSL"; else GET="wget -qO-"; fi`;
  if (target === "paste") {
    return [
      `SUDO=$([ "$(id -u)" -eq 0 ] || echo sudo)`,
      detect,
      `$GET ${installUrl}/setup | $SUDO bash -s -- \\`,
      body,
    ].join("\n");
  }
  // Downloaded to a file so the exit status is setup's own: piped, a failed
  // download reads as success, and a dry run that exits early reads as failure.
  return [
    `SUDO=$([ "$(id -u)" -eq 0 ] || echo "sudo -n")`,
    detect,
    `SETUP=$(mktemp) || exit 1`,
    `trap 'rm -f "$SETUP"' EXIT`,
    `$GET ${installUrl}/setup > "$SETUP" || exit $?`,
    `$SUDO bash "$SETUP" \\`,
    `${body} </dev/null`,
  ].join("\n");
}

export function buildSetupCommand(opts: SetupOptions, target: SetupTarget): string {
  const args = [
    `--install-url ${opts.installUrl}`,
    `--token ${opts.token}`,
    `--user ${opts.adminUser}`,
  ];
  if (opts.gatewayUrl) args.push(`--gateway ${opts.gatewayUrl}`);
  if (opts.hostname) args.push(`--hostname ${opts.hostname}`);
  if (opts.harden) args.push(...hardeningArgs(opts.firewallAllow, opts.trustedIps, target));
  args.push(opts.check ? "--check" : "--yes");
  return renderCommand(opts.installUrl, args, target);
}

export function buildHardenCommand(opts: HardenOptions, target: SetupTarget): string {
  const args = [
    "--harden-only",
    ...(opts.sshOnly
      ? ["--harden-ssh"]
      : hardeningArgs(opts.firewallAllow, opts.trustedIps, target)),
    `--user ${opts.adminUser}`,
    opts.check ? "--check" : "--yes",
  ];
  return renderCommand(opts.installUrl, args, target);
}

/** The CLI invocation that hardens `server`, for tools that hand it to a person
 *  or agent. Leaves out --yes so the run stops at its confirmation prompt. */
export function buildHardenCliCommand(
  server: string,
  opts: { adminUser?: string; sshOnly?: boolean; firewallAllow: string[]; trustedIps: string[] },
): string {
  const parts = ["reoclo", "servers", "harden", server];
  if (opts.adminUser !== undefined) parts.push("--user", opts.adminUser);
  if (opts.sshOnly) parts.push("--ssh-only");
  if (opts.firewallAllow.length > 0) parts.push("--firewall-allow", opts.firewallAllow.join(","));
  for (const ip of opts.trustedIps) parts.push("--trusted-ip", ip);
  return parts.join(" ");
}

export interface ListeningPort {
  port?: number | string;
  address?: string;
  process?: string;
}

export interface PortScan {
  listening_ports: ListeningPort[];
  docker_port_bindings?: Array<{ host_port?: number | string; host_address?: string }>;
}

/** Everything a port scan found bound on the host, including container ports. */
export function scannedPorts(scan: PortScan): ListeningPort[] {
  const bound = (scan.docker_port_bindings ?? []).map((b) => ({
    port: b.host_port,
    address: b.host_address,
  }));
  return [...scan.listening_ports, ...bound];
}

/** Publicly bound ports the hardened firewall would start blocking: anything
 *  outside SSH, 80, 443 and the ports the caller is opening. */
export function portsBlockedByHardening(
  listening: ListeningPort[],
  firewallAllow: string[],
): number[] {
  const open = (port: number): boolean =>
    firewallAllow.some((entry) => {
      const m = PORT_RE.exec(entry);
      if (!m) return false;
      const lo = Number(m[1]);
      return port === lo || (m[2] !== undefined && port >= lo && port <= Number(m[2]));
    });
  const blocked = new Set<number>();
  for (const l of listening) {
    const port = Number(l.port);
    const address = l.address ?? "";
    const isPublic = address === "" || address === "*" || address === "0.0.0.0" || address === "::";
    if (!isPublic || !Number.isInteger(port)) continue;
    if (port === 80 || port === 443 || l.process?.includes("sshd") || open(port)) continue;
    blocked.add(port);
  }
  return [...blocked].sort((a, b) => a - b);
}
