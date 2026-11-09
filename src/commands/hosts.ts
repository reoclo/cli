// src/commands/hosts.ts
//
// `reoclo hosts ls|add|rm|sync|setup|uninstall`: the local hostnames that point
// at tunnels. Hostnames reach /etc/hosts only through the root helper, which
// `setup` installs once with sudo.

import type { Command } from "commander";
import { answers } from "../hostsd/main";
import { realRunner, type CommandRunner } from "../tunnels/command-runner";
import { loadConfig } from "../tunnels/config";
import { ControlClient, connectToDaemon, DaemonError, type HostsListing } from "../tunnels/control-client";
import { isValidHostname } from "../tunnels/hosts-block";
import { globalOutput, printList, printMutation, resolveFormat } from "../ui/output";
import { UsageError } from "./tunnel-saved";

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function fail(err: unknown): never {
  console.error(`hosts: ${err instanceof Error ? err.message : String(err)}`);
  const code = (err as { exitCode?: unknown } | null)?.exitCode;
  process.exit(typeof code === "number" ? code : 1);
}

export interface SetupInput {
  execPath: string;
  script: string | undefined;
  uid: number;
  allowSuffixes: string[];
  port443: boolean;
  relayPort: number;
  /** Running as root already, so no sudo. */
  root: boolean;
}

/** True when this process is a compiled binary that can be copied to a root-owned path. */
export function isCompiledBinary(script: string | undefined): boolean {
  return script === undefined || script.startsWith("/$bunfs/") || script.startsWith("B:/~BUN");
}

export function buildSetupCommand(i: SetupInput): { cmd: string; args: string[] } {
  const args = ["__hostsd-install", "--uid", String(i.uid)];
  for (const s of i.allowSuffixes) args.push("--allow-suffix", s);
  if (i.port443) args.push("--port-443", "--relay-port", String(i.relayPort));
  return i.root ? { cmd: i.execPath, args } : { cmd: "sudo", args: [i.execPath, ...args] };
}

export function buildUninstallCommand(execPath: string, root: boolean): { cmd: string; args: string[] } {
  return root ? { cmd: execPath, args: ["__hostsd-uninstall"] } : { cmd: "sudo", args: [execPath, "__hostsd-uninstall"] };
}

function requireCompiled(what: string): void {
  if (!isCompiledBinary(process.argv[1])) {
    throw new UsageError(`${what} needs the compiled reoclo binary, because the helper runs from a root-owned copy of it; it cannot run from bun run`);
  }
}

function requireUser(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new UsageError("the hosts helper is not supported on this platform");
  if (uid === 0) throw new UsageError("run this as your own user; it asks for sudo itself");
  return uid;
}

/** Refuse when something already answers on port 443, such as the Reoclo dev stack's Caddy. */
export async function assertPort443Free(
  probe: (port: number, host: string) => Promise<boolean> = answers,
): Promise<void> {
  if ((await probe(443, "127.0.0.1")) || (await probe(443, "::1"))) {
    throw new UsageError(
      "something already answers on port 443 (for example the Reoclo dev stack's Caddy for *.reoclo.test); the relay would capture its traffic. Stop it first, or leave --port-443 off and keep the :8443 URLs",
    );
  }
}

export function formatListing(listing: HostsListing, fmt: "text" | "json" | "yaml"): void {
  if (fmt === "json") {
    for (const e of listing.entries) process.stdout.write(JSON.stringify(e) + "\n");
    return;
  }
  if (listing.entries.length === 0) {
    process.stdout.write("no hostnames; add one with: reoclo hosts add <name>, or save an https tunnel\n");
  } else {
    printList(listing.entries.map((e) => ({ hostname: e.hostname, source: e.source })), [
      { key: "hostname", label: "HOSTNAME" },
      { key: "source", label: "SOURCE" },
    ], fmt);
  }
  if (fmt === "text") process.stdout.write(`${helperLine(listing.helper)}\n`);
}

export function helperLine(h: HostsListing["helper"]): string {
  if (!h.installed) return "helper: not installed; run reoclo hosts setup to write /etc/hosts";
  if (h.error) return `helper: error: ${h.error}`;
  const relay = h.relay.enabled
    ? h.relay.listening
      ? `port 443 relays to ${h.relay.port}`
      : `port 443 relay is off${h.relay.error ? ` (${h.relay.error})` : ""}`
    : "port 443 relay off";
  return `helper: installed, ${h.entries} entries in /etc/hosts, ${relay}`;
}

async function run(runner: CommandRunner, cmd: string, args: string[]): Promise<void> {
  const r = await runner(cmd, args, { inherit: true });
  if (r.code !== 0) throw new Error(`${cmd} ${args[0] ?? ""} exited with code ${r.code}`);
}

export function registerHosts(program: Command): void {
  const hosts = program
    .command("hosts")
    .description("manage the local hostnames that point at tunnels")
    .addHelpText(
      "after",
      `
Hostnames of saved tunnels reach /etc/hosts through a small root helper that
\`reoclo hosts setup\` installs once. Chrome, Firefox and curl resolve
*.localhost without it; Safari and most other macOS apps need it.
`,
    );

  hosts
    .command("ls")
    .description("list the hostnames in the managed hosts block")
    .action(async () => {
      try {
        formatListing(await (await connectToDaemon()).hosts(), resolveFormat(globalOutput(program)));
      } catch (err) {
        fail(err);
      }
    });

  hosts
    .command("add <name...>")
    .description("add hostnames that point at loopback with no tunnel behind them")
    .action(async (names: string[]) => {
      try {
        const wanted = names.map((n) => n.trim().toLowerCase());
        for (const n of wanted) if (!isValidHostname(n)) throw new UsageError(`invalid hostname ${JSON.stringify(n)}`);
        const client = await connectToDaemon();
        const current = (await client.settings()).manual_hosts;
        await client.updateSettings({ manual_hosts: [...new Set([...current, ...wanted])].sort() });
        for (const name of wanted) printMutation(program, { hostname: name, added: true }, `hosts: added ${name}`);
      } catch (err) {
        fail(err);
      }
    });

  hosts
    .command("rm <name...>")
    .description("remove hostnames added with hosts add; tunnel hostnames follow their tunnel")
    .action(async (names: string[]) => {
      try {
        const wanted = names.map((n) => n.trim().toLowerCase());
        const client = await connectToDaemon();
        const current = (await client.settings()).manual_hosts;
        const missing = wanted.filter((n) => !current.includes(n));
        if (missing.length > 0) {
          throw new UsageError(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not manual hostnames; a tunnel's hostname goes away with the tunnel`);
        }
        await client.updateSettings({ manual_hosts: current.filter((n) => !wanted.includes(n)) });
        for (const name of wanted) printMutation(program, { hostname: name, removed: true }, `hosts: removed ${name}`);
      } catch (err) {
        fail(err);
      }
    });

  hosts
    .command("sync")
    .description("send the full hostname list to the helper again")
    .action(async () => {
      try {
        const listing = await (await connectToDaemon()).syncHosts();
        if (resolveFormat(globalOutput(program)) === "json") {
          printMutation(program, listing as unknown as Record<string, unknown>, "");
        } else {
          console.log(`hosts: ${helperLine(listing.helper).replace(/^helper: /, "")}`);
        }
        if (!listing.helper.installed || listing.helper.error) process.exit(1);
      } catch (err) {
        fail(err);
      }
    });

  hosts
    .command("setup")
    .description("install the root hosts helper (asks for sudo once)")
    .option("--allow-suffix <suffix>", "also let the helper write names under this suffix, such as internal (repeatable)", collect)
    .option("--port-443", "relay 127.0.0.1:443 and [::1]:443 to the HTTPS port so URLs drop the port")
    .addHelpText(
      "after",
      `
By default HTTPS tunnels listen on port 8443 and their URLs carry :8443, because
an ordinary user cannot bind port 443. --port-443 makes the helper relay port 443
to that port. It refuses while another program answers on 443, such as the
Reoclo dev stack's Caddy for *.reoclo.test, because the relay would capture its
traffic.

Examples:
  $ reoclo hosts setup
  $ reoclo hosts setup --allow-suffix internal
  $ reoclo hosts setup --port-443
`,
    )
    .action(async (opts: { allowSuffix?: string[]; port443?: boolean }) => {
      try {
        requireCompiled("hosts setup");
        const uid = requireUser();
        if (opts.port443) await assertPort443Free();
        const { cmd, args } = buildSetupCommand({
          execPath: process.execPath,
          script: process.argv[1],
          uid,
          allowSuffixes: opts.allowSuffix ?? [],
          port443: opts.port443 === true,
          relayPort: loadConfig().https_port,
          root: false,
        });
        await run(realRunner, cmd, args);
        const listing = await (await connectToDaemon()).syncHosts();
        console.log(`hosts: ${helperLine(listing.helper).replace(/^helper: /, "")}`);
        if (opts.port443) console.log("hosts: URLs no longer carry a port");
      } catch (err) {
        fail(err);
      }
    });

  hosts
    .command("uninstall")
    .description("remove the root hosts helper and the managed block (asks for sudo)")
    .action(async () => {
      try {
        requireCompiled("hosts uninstall");
        requireUser();
        const { cmd, args } = buildUninstallCommand(process.execPath, false);
        await run(realRunner, cmd, args);
        try {
          await new ControlClient().syncHosts();
        } catch (err) {
          if (!(err instanceof DaemonError)) throw err;
        }
      } catch (err) {
        fail(err);
      }
    });
}
