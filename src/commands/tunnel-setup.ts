// src/commands/tunnel-setup.ts
//
// `reoclo tunnel setup`: one command for the one-time steps a machine needs
// before tunnels work well. The steps are the same code as `tunnel daemon
// install`, `tunnel trust` and `hosts setup`.

import type { Command } from "commander";
import { connectToDaemon } from "../tunnels/control-client";
import { installService, serviceInstalled } from "../tunnels/service";
import { readiness, runSetup, type SetupOutcome, type SetupStepName } from "../tunnels/setup";
import { globalOutput, printObject, resolveFormat } from "../ui/output";
import { installHostsHelper } from "./hosts";
import { trustLocalCa } from "./tunnel-trust";

const STEP_LABEL: Record<SetupStepName, string> = {
  service: "start at login",
  trust: "local CA",
  hosts: "hosts helper",
};

const OUTCOME_LABEL: Record<SetupOutcome, string> = {
  done: "done",
  already: "ok",
  skipped: "skipped",
  failed: "FAILED",
};

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

interface SetupFlags {
  domain?: string[];
  port443?: boolean;
  service: boolean;
  trust: boolean;
  hosts: boolean;
}

export function registerTunnelSetup(tunnelCmd: Command, program: Command): void {
  tunnelCmd
    .command("setup")
    .description("prepare this machine for tunnels: start the daemon at login, trust the local CA, install the hosts helper")
    .option("--domain <suffix>", "also allow this suffix for certificates and hostnames, such as internal (repeatable)", collect)
    .option("--port-443", "relay port 443 to the HTTPS port so URLs drop the port")
    .option("--no-service", "do not start the daemon at login")
    .option("--no-trust", "do not trust the local CA")
    .option("--no-hosts", "do not install the hosts helper")
    .addHelpText(
      "after",
      `
Safe to run again: a step that is already done is left alone, and a step that
fails does not stop the others. Trusting the CA can raise a system prompt and the
hosts helper asks for sudo, so run this in a terminal.

Examples:
  $ reoclo tunnel setup
  $ reoclo tunnel setup --port-443
  $ reoclo tunnel setup --domain internal
  $ reoclo tunnel setup --no-hosts
`,
    )
    .action(async (flags: SetupFlags) => {
      const fmt = resolveFormat(globalOutput(program));
      const domains = flags.domain ?? [];
      const report = await runSetup(
        {
          interactive: process.stdin.isTTY === true,
          serviceInstalled,
          installService: () => installService().message,
          status: async () => {
            try {
              return await (await connectToDaemon()).status();
            } catch {
              return undefined;
            }
          },
          trust: trustLocalCa,
          installHosts: (o) => installHostsHelper({ allowSuffix: o.domains, port443: o.port443 }),
          progress: (message) => console.error(`tunnel setup: ${message}`),
        },
        { service: flags.service, trust: flags.trust, hosts: flags.hosts, domains, port443: flags.port443 === true },
      );
      const ready = readiness(report.status);
      if (fmt === "text") {
        for (const s of report.steps) {
          console.log(`${STEP_LABEL[s.step].padEnd(16)}${OUTCOME_LABEL[s.outcome].padEnd(9)}${s.detail}`);
        }
        console.log();
        for (const [label, text] of ready) console.log(`${label.padEnd(16)}${text}`);
        if (report.ok) {
          console.log();
          console.log("next: reoclo tunnel add <name> --server <server> --kind https --target <port>");
        }
      } else {
        printObject({ ok: report.ok, steps: report.steps, readiness: Object.fromEntries(ready) }, fmt);
      }
      if (!report.ok) process.exit(1);
    });
}
