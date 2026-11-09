// src/commands/tunnel-trust.ts
//
// `reoclo tunnel trust|untrust|ca-path`: the local CA that signs the
// certificates for HTTPS tunnels. These commands run in the CLI process, not the
// daemon, because trusting a CA needs a terminal for the keychain or sudo prompt.

import { existsSync } from "node:fs";
import type { Command } from "commander";
import { connectToDaemon, DaemonError } from "../tunnels/control-client";
import { HostnameError } from "../tunnels/hosts-block";
import { localCaActions, mergeSuffixList } from "../tunnels/ca-actions";
import { loadConfig } from "../tunnels/config";
import { caCertFile } from "../tunnels/paths";
import { UsageError } from "./tunnel-saved";

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function fail(err: unknown): never {
  console.error(`tunnel: ${err instanceof Error ? err.message : String(err)}`);
  const code = (err as { exitCode?: unknown } | null)?.exitCode;
  process.exit(typeof code === "number" ? code : 1);
}

/** The suffixes the CA must cover: the ones already in tunnels.yaml plus the new ones, each checked. */
export function mergeSuffixes(existing: readonly string[], requested: readonly string[]): string[] {
  try {
    return mergeSuffixList(existing, requested);
  } catch (e) {
    if (e instanceof HostnameError) throw new UsageError(e.message);
    throw e;
  }
}

async function tellDaemon(suffixes: string[] | undefined): Promise<void> {
  try {
    const client = await connectToDaemon({ autoStart: suffixes !== undefined });
    if (suffixes !== undefined) await client.updateSettings({ ca_suffixes: suffixes });
    await client.reloadCa();
  } catch (err) {
    if (err instanceof DaemonError && err.code === "not_running") return;
    console.error(`tunnel: the CA changed, but the daemon could not be told: ${err instanceof Error ? err.message : String(err)}`);
    console.error("tunnel: restart it with: reoclo tunnel daemon stop && reoclo tunnel daemon start");
  }
}

/** Create the CA if needed and trust it. Returns what happened, one line each. */
export async function trustLocalCa(domains: string[]): Promise<string[]> {
  const suffixes = mergeSuffixes(loadConfig().ca_suffixes, domains);
  const result = await localCaActions.trust(suffixes);
  await tellDaemon(suffixes);
  return [
    ...result.lines,
    `the CA covers ${result.suffixes.join(", ")}`,
    (await import("../tunnels/trust")).firefoxHint(),
  ];
}

export function registerTunnelTrust(tunnelCmd: Command): void {
  tunnelCmd
    .command("trust")
    .description("create the local CA and trust it, so browsers accept HTTPS tunnels")
    .option("--domain <suffix>", "also allow certificates under this suffix, such as internal (repeatable)", collect)
    .addHelpText(
      "after",
      `
The CA is limited by a name constraint to reoclo.localhost and the suffixes you
allow, so a leaked key cannot sign for any other domain. Changing the suffixes
issues a new CA and asks for trust again.

Examples:
  $ reoclo tunnel trust
  $ reoclo tunnel trust --domain internal
`,
    )
    .action(async (opts: { domain?: string[] }) => {
      try {
        for (const line of await trustLocalCa(opts.domain ?? [])) console.log(`tunnel: ${line}`);
      } catch (err) {
        fail(err);
      }
    });

  tunnelCmd
    .command("untrust")
    .description("remove the local CA from the system trust store and delete its key")
    .action(async () => {
      try {
        const { lines } = await localCaActions.untrust();
        for (const line of lines) console.log(`tunnel: ${line}`);
        await tellDaemon(undefined);
      } catch (err) {
        fail(err);
      }
    });

  tunnelCmd
    .command("ca-path")
    .description("print the path of the CA certificate, for NODE_EXTRA_CA_CERTS or curl --cacert")
    .action(() => {
      const path = caCertFile();
      if (!existsSync(path)) {
        console.error("tunnel: there is no local CA yet; run: reoclo tunnel trust");
        process.exit(1);
      }
      console.log(path);
    });
}
