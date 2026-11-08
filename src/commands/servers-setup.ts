// src/commands/servers-setup.ts
//
// `servers add` and `servers harden`. Both run setup.sh on the server as root,
// which the runner cannot do (its sudoers whitelist covers systemctl, reboot
// and firewall tools only), so they go over the operator's own SSH access or
// print a command to paste.
import { spawn } from "node:child_process";
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveServer } from "../client/resolve";
import { withCompletion } from "../client/command-meta";
import { ApiError } from "../client/errors";
import { EXIT } from "../client/exit-codes";
import {
  buildHardenCommand,
  buildSetupCommand,
  formatSshDestination,
  parseFirewallPorts,
  parseHostname,
  parseSshDestination,
  parseTrustedIps,
  portsBlockedByHardening,
  scannedPorts,
  parseInstallUrl,
  resolveAdminUser,
  type PortScan,
  type SshDestination,
} from "../client/server-setup";
import type { Server } from "../client/types";
import { globalOutput, printMutation, printObject, resolveFormat } from "../ui/output";
import { confirmOrExit } from "../ui/prompt";
import { badUsage, parseIntFlag } from "../util/parse-flag";
import { getUrl } from "../lib/urls";
import { pollUntilState } from "./servers-power";

const WAIT_POLL_MS = 3000;
// setup.sh is never run with this: --check validates the plan and masks it.
const CHECK_TOKEN = "rt_check_only";

interface SshFlags {
  port?: string;
  identity?: string;
}

interface RunnerTokenResponse {
  token: { id: string; expires_at: string };
  plaintext_token: string;
  runner_gateway_url: string | null;
  runner_install_url: string | null;
}

interface RunnerTokenStatus {
  status: string;
  used_by_server_id: string | null;
}

/** Where `<install url>/setup` is served for the API this profile talks to, so a
 *  profile logged in to staging never runs production's script. */
export function resolveInstallUrl(flag: string | undefined, api: string): string {
  if (flag !== undefined) return parseInstallUrl(flag);
  if (!process.env["REOCLO_GET_URL"]) {
    const u = new URL(api);
    const match = u.host.match(/^(?:api|direct)\.(.+)$/);
    if (match) return `${u.protocol}//get.${match[1]}`;
  }
  return getUrl();
}

function failure(message: string, exitCode: number = EXIT.GENERIC): Error & { exitCode: number } {
  return Object.assign(new Error(message), { exitCode });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Arguments for `ssh`. A first connection accepts and records the host key;
 *  a key that later changes is still refused. */
export function buildSshArgs(dest: SshDestination, flags: SshFlags): string[] {
  const args = ["-o", "StrictHostKeyChecking=accept-new"];
  if (flags.port !== undefined) {
    args.push("-p", String(parseIntFlag(flags.port, "--port", 1, 65535)));
  }
  // Without IdentitiesOnly, ssh offers every agent key first. Each rejected key
  // counts as a failed login, which ends the connection and feeds fail2ban.
  if (flags.identity !== undefined) args.push("-i", flags.identity, "-o", "IdentitiesOnly=yes");
  args.push(formatSshDestination(dest), "bash", "-s");
  return args;
}

/** Run `script` on the server through `bash -s`. The script goes over stdin so
 *  a runner token never appears in this machine's process list. Returns the
 *  exit code; stdout is kept off our stdout when the caller is printing JSON. */
function runOverSsh(args: string[], script: string, quietStdout: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, {
      stdio: ["pipe", quietStdout ? process.stderr : "inherit", "inherit"],
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "ENOENT"
          ? failure("ssh was not found on PATH. Install OpenSSH, or leave out --ssh to print the command.")
          : err,
      );
    });
    child.on("close", (code) => resolve(code ?? EXIT.GENERIC));
    child.stdin.end(script);
  });
}

/** ssh itself exits 255 when it cannot connect or authenticate. */
function sshFailure(dest: SshDestination, code: number): Error & { exitCode: number } {
  const target = formatSshDestination(dest);
  if (code === 255) {
    return failure(`could not connect to ${target} over SSH. Check the address, user and key.`);
  }
  const sudoHint =
    dest.user === "root"
      ? ""
      : " A non-root user needs passwordless sudo; without it, print the command and paste it on the server.";
  return failure(`setup failed on ${target} (exit ${code}). See the output above.${sudoHint}`);
}

export function registerServersSetup(program: Command, g: Command): void {
  g.command("add")
    .description("set up a new server and connect it to this organization")
    .option("--ssh <[user@]host>", "run setup on this host over SSH (omit to print the command)")
    .option("--port <port>", "SSH port")
    .option("-i, --identity <file>", "SSH private key file")
    .option("--user <name>", "admin user that runs Docker and the runner (default: the SSH user, or ubuntu)")
    .option("--name <name>", "name shown for the server, which also sets its slug (default: --hostname, or the SSH host)")
    .option("--hostname <name>", "hostname to register the server under")
    .option("--no-harden", "skip hardening (root and password SSH, firewall, fail2ban, updates)")
    .option("--firewall-allow <ports>", "extra ports to open, e.g. 8080,9000:9100/udp (repeatable)", collect, [])
    .option("--trusted-ip <ip>", "address or CIDR that fail2ban never bans (repeatable)", collect, [])
    .option("--install-url <url>", "where setup is served (default: follows the API you are logged in to)")
    .option("--cloud-init", "print a cloud-init user-data script instead of an SSH command")
    .option("--check", "dry run with --ssh: print the plan and change nothing")
    .option("--no-wait", "do not wait for the server to connect")
    .option("--wait-timeout <seconds>", "how long to wait for the server to connect", "120")
    .option("--yes", "skip the confirmation prompt")
    .action(
      async (opts: SshFlags & {
        ssh?: string;
        user?: string;
        name?: string;
        hostname?: string;
        harden: boolean;
        firewallAllow: string[];
        trustedIp: string[];
        installUrl?: string;
        cloudInit?: boolean;
        check?: boolean;
        wait: boolean;
        waitTimeout: string;
        yes?: boolean;
      }) => {
        if (opts.ssh !== undefined && opts.cloudInit) {
          throw badUsage("--ssh and --cloud-init cannot be used together");
        }
        if (opts.check && opts.ssh === undefined) {
          throw badUsage("--check needs --ssh: it runs the dry run on the server");
        }
        const dest = opts.ssh === undefined ? undefined : parseSshDestination(opts.ssh);
        const name = opts.name ?? opts.hostname ?? dest?.host;
        if (name === undefined) {
          throw badUsage("--name is required without --ssh: the new server needs a name");
        }
        const waitTimeout = parseIntFlag(opts.waitTimeout, "--wait-timeout", 1, 3600);
        const shared = {
          adminUser: resolveAdminUser(opts.user, dest?.user),
          hostname: opts.hostname === undefined ? undefined : parseHostname(opts.hostname),
          harden: opts.harden,
          firewallAllow: parseFirewallPorts(opts.firewallAllow),
          trustedIps: parseTrustedIps(opts.trustedIp),
        };

        const fmt = resolveFormat(globalOutput(program));
        const quietStdout = fmt === "json" || fmt === "yaml";
        const ctx = await bootstrap();

        if (opts.check && dest) {
          const script = buildSetupCommand(
            {
              ...shared,
              installUrl: resolveInstallUrl(opts.installUrl, ctx.api),
              token: CHECK_TOKEN,
              gatewayUrl: null,
              check: true,
            },
            "ssh",
          );
          const code = await runOverSsh(buildSshArgs(dest, opts), script, quietStdout);
          if (code !== 0) throw sshFailure(dest, code);
          return;
        }

        if (dest) {
          const hardening = opts.harden
            ? " and harden it (no root or password SSH logins, default-deny firewall)"
            : "";
          await confirmOrExit(
            `Set up ${formatSshDestination(dest)} as a Reoclo server${hardening}? [y/N] `,
            opts.yes,
          );
        }

        const tid = await requireTenantId(ctx);
        const created = await ctx.client.post<RunnerTokenResponse>(
          `/admin/runners/tokens?tenant_id=${tid}`,
          { label: name },
        );
        const tokenPath = `/admin/runners/tokens/${created.token.id}`;
        const options = {
          ...shared,
          installUrl: created.runner_install_url
            ? resolveInstallUrl(opts.installUrl ?? created.runner_install_url, ctx.api)
            : resolveInstallUrl(opts.installUrl, ctx.api),
          token: created.plaintext_token,
          gatewayUrl: created.runner_gateway_url,
        };

        if (!dest) {
          const command = buildSetupCommand(options, opts.cloudInit ? "cloud-init" : "paste");
          if (quietStdout) {
            printObject(
              { command, token_id: created.token.id, expires_at: created.token.expires_at },
              fmt,
            );
            return;
          }
          process.stdout.write(`${command}\n`);
          process.stderr.write(
            `\nThis command holds a single-use token that expires at ${created.token.expires_at}.\n`,
          );
          return;
        }

        const target = formatSshDestination(dest);
        const code = await runOverSsh(
          buildSshArgs(dest, opts),
          buildSetupCommand(options, "ssh"),
          quietStdout,
        );
        if (code !== 0) {
          // The token was never used, so do not leave it valid for the next hour.
          await ctx.client.del(tokenPath).catch((err: unknown) => {
            process.stderr.write(`warning: could not revoke the unused runner token: ${String(err)}\n`);
          });
          throw sshFailure(dest, code);
        }

        const rootLoginOff =
          opts.harden && (dest.user === "root" || dest.user === undefined)
            ? `  root SSH login is off now. Log in as ${shared.adminUser}.\n`
            : "";

        if (!opts.wait) {
          printMutation(program, { host: dest.host, hardened: opts.harden }, `✓ setup finished on ${target}`);
          if (!quietStdout) process.stdout.write(rootLoginOff);
          return;
        }

        let serverId = null as string | null;
        const result = await pollUntilState({
          statusFn: async () => {
            const t = await ctx.client.get<RunnerTokenStatus>(tokenPath);
            serverId = t.used_by_server_id;
            return t.status;
          },
          target: "used",
          attempts: Math.max(1, Math.ceil((waitTimeout * 1000) / WAIT_POLL_MS)),
          sleepMs: WAIT_POLL_MS,
        });
        if (!result.reached || serverId === null) {
          throw failure(
            `setup finished on ${target}, but the server did not connect within ${waitTimeout}s. On the server, check: journalctl -u reoclo-runner`,
          );
        }
        const server = await ctx.client.get<Server>(`/tenants/${tid}/servers/${serverId}`);
        printMutation(
          program,
          server as unknown as Record<string, unknown>,
          `✓ server connected: ${server.slug}`,
        );
        if (!quietStdout) process.stdout.write(rootLoginOff);
      },
    );

  withCompletion(
    g
      .command("harden <idOrSlug>")
      .description("harden an existing server over SSH (or print the command)")
      .option("--ssh <[user@]host>", "SSH destination (default: the admin user at the server's IP)")
      .option("--port <port>", "SSH port")
      .option("-i, --identity <file>", "SSH private key file")
      .option("--user <name>", "admin user that must keep SSH access (default: the SSH user, or ubuntu)")
      .option("--ssh-only", "only lock down SSH: no firewall, fail2ban or automatic updates")
      .option("--firewall-allow <ports>", "extra ports to open, e.g. 8080,9000:9100/udp (repeatable)", collect, [])
      .option("--trusted-ip <ip>", "address or CIDR that fail2ban never bans (repeatable)", collect, [])
      .option("--install-url <url>", "where setup is served (default: follows the API you are logged in to)")
      .option("--print", "print the command instead of running it")
      .option("--check", "dry run: print the plan and change nothing")
      .option("--yes", "skip the confirmation prompt")
      .action(
        async (
          idOrSlug: string,
          opts: SshFlags & {
            ssh?: string;
            user?: string;
            sshOnly?: boolean;
            firewallAllow: string[];
            trustedIp: string[];
            installUrl?: string;
            print?: boolean;
            check?: boolean;
            yes?: boolean;
          },
        ) => {
          if (opts.print && opts.check) {
            throw badUsage("--print and --check cannot be used together");
          }
          const explicit = opts.ssh === undefined ? undefined : parseSshDestination(opts.ssh);
          const adminUser = resolveAdminUser(opts.user, explicit?.user);
          const firewallAllow = parseFirewallPorts(opts.firewallAllow);
          const trustedIps = parseTrustedIps(opts.trustedIp);

          const fmt = resolveFormat(globalOutput(program));
          const quietStdout = fmt === "json" || fmt === "yaml";
          const ctx = await bootstrap();
          const tid = await requireTenantId(ctx);
          const sid = await resolveServer(ctx.client, tid, idOrSlug);
          const options = {
            adminUser,
            installUrl: resolveInstallUrl(opts.installUrl, ctx.api),
            sshOnly: opts.sshOnly,
            firewallAllow,
            trustedIps,
            check: opts.check,
          };

          if (opts.print) {
            const command = buildHardenCommand(options, "paste");
            if (quietStdout) printObject({ command }, fmt);
            else process.stdout.write(`${command}\n`);
            return;
          }

          const server = await ctx.client.get<Server>(`/tenants/${tid}/servers/${sid}`);
          let dest = explicit;
          if (!dest) {
            const host = server.ip ?? server.public_ip;
            if (!host) {
              throw badUsage(`server '${idOrSlug}' has no recorded IP. Pass --ssh <[user@]host>.`);
            }
            dest = { user: adminUser, host };
          }
          const target = formatSshDestination(dest);

          if (!opts.check) {
            if (!opts.sshOnly) {
              await warnAboutBlockedPorts(ctx.client, `/tenants/${tid}/servers/${sid}/ports`, firewallAllow);
            }
            const scope = opts.sshOnly
              ? "disables root and password SSH logins"
              : "disables root and password SSH logins and enables a default-deny firewall";
            await confirmOrExit(`Harden ${idOrSlug} over ${target}? This ${scope}. [y/N] `, opts.yes);
          }

          const code = await runOverSsh(
            buildSshArgs(dest, opts),
            buildHardenCommand(options, "ssh"),
            quietStdout,
          );
          if (code !== 0) throw sshFailure(dest, code);
          if (opts.check) return;

          printMutation(
            program,
            { id: sid, slug: server.slug, hardened: true, ssh_only: opts.sshOnly === true },
            `✓ hardened: ${idOrSlug}`,
          );
          if (!quietStdout) {
            if (dest.user === "root") {
              process.stdout.write(`  root SSH login is off now. Log in as ${adminUser}.\n`);
            }
            process.stdout.write(`  Confirm with: reoclo servers ports ${idOrSlug}\n`);
          }
        },
      ),
    { args: [{ slot: 0, resource: "servers" }] },
  );
}

/** Warn before the firewall closes ports that are serving traffic today. The
 *  scan needs a connected runner, so a server without one only gets a note. */
async function warnAboutBlockedPorts(
  client: { get: <T>(path: string) => Promise<T> },
  path: string,
  firewallAllow: string[],
): Promise<void> {
  try {
    const res = await client.get<PortScan>(path);
    const blocked = portsBlockedByHardening(scannedPorts(res), firewallAllow);
    if (blocked.length > 0) {
      process.stderr.write(
        `warning: the firewall may block these listening ports: ${blocked.join(", ")}. Keep them open with --firewall-allow ${blocked.join(",")}.\n`,
      );
    }
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    process.stderr.write(
      `warning: could not check listening ports (${err.message}). Ports other than SSH, 80 and 443 will be blocked unless you pass --firewall-allow.\n`,
    );
  }
}
