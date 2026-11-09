// src/hostsd/entry.ts
//
// The hidden commands the root helper runs as: `__hostsd` (the service),
// `__hostsd-install` and `__hostsd-uninstall` (run under sudo by `reoclo hosts
// setup` and `uninstall`). src/index.ts dispatches here before Commander and
// before it reads any user config, so the helper never loads a profile.

import pkg from "../../package.json" with { type: "json" };
import { assertValidSuffix } from "../tunnels/hosts-block";
import { HostsClient } from "../tunnels/hosts-client";
import { installHostsd, uninstallHostsd, InstallError, waitForHelper } from "./install";
import { startHostsd } from "./main";
import { hostsdPaths, isRoot, sandboxDir } from "./paths";

export const HOSTSD_VERBS = ["__hostsd", "__hostsd-install", "__hostsd-uninstall"] as const;

export function isHostsdInvocation(argv: readonly string[]): boolean {
  return (HOSTSD_VERBS as readonly string[]).includes(argv[2] ?? "");
}

export interface InstallArgs {
  uid: number;
  allowSuffixes: string[];
  port443: boolean;
  relayPort?: number;
}

export function parseInstallArgs(args: readonly string[]): InstallArgs {
  const out: InstallArgs = { uid: Number.NaN, allowSuffixes: [], port443: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = (): string => {
      const v = args[++i];
      if (v === undefined) throw new InstallError(`${String(a)} needs a value`);
      return v;
    };
    if (a === "--uid") out.uid = Number(value());
    else if (a === "--allow-suffix") {
      const s = value();
      assertValidSuffix(s);
      out.allowSuffixes.push(s);
    } else if (a === "--port-443") out.port443 = true;
    else if (a === "--relay-port") out.relayPort = Number(value());
    else throw new InstallError(`unknown option ${String(a)}`);
  }
  if (Number.isNaN(out.uid)) throw new InstallError("--uid is required");
  return out;
}

function say(line: string): void {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
}

/** Runs the verb and exits the process; the service verb returns only on a signal. */
export async function runHostsdEntry(argv: readonly string[]): Promise<never> {
  const verb = argv[2];
  const paths = hostsdPaths();
  const sandboxed = sandboxDir() !== undefined;
  try {
    if (verb === "__hostsd") {
      const listenPort = Number(process.env["REOCLO_HOSTSD_RELAY_LISTEN"]);
      const handle = await startHostsd({
        configFile: paths.config,
        hostsFile: paths.hostsFile,
        socketPath: paths.socket,
        version: pkg.version,
        log: say,
        // Only a sandboxed (non-root) run reads the environment, and only for the relay port and DNS flush.
        ...(sandboxed ? { flushDns: () => Promise.resolve(), ...(listenPort > 0 ? { relayListenPort: listenPort } : {}) } : {}),
      });
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
      await handle.stop();
      process.exit(0);
    }
    if (!isRoot() && !sandboxed) {
      process.stderr.write(`${String(verb)} must run as root; use reoclo hosts setup\n`);
      process.exit(1);
    }
    if (verb === "__hostsd-install") {
      const args = parseInstallArgs(argv.slice(3));
      const lines = await installHostsd({
        ...args,
        sourceBinary: process.execPath,
        platform: process.platform,
        paths,
        chownRoot: !sandboxed,
        ...(sandboxed
          ? { run: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }) }
          : { waitUntilUp: () => waitForHelper(() => new HostsClient(paths.socket, 1000).status()) }),
      });
      for (const l of lines) process.stdout.write(`${l}\n`);
      process.exit(0);
    }
    const lines = await uninstallHostsd({
      platform: process.platform,
      paths,
      ...(sandboxed ? { run: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }) } : {}),
    });
    for (const l of lines) process.stdout.write(`${l}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`${String(verb)}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
