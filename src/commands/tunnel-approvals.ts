// src/commands/tunnel-approvals.ts
//
// `reoclo tunnel approvals|approve|deny`: the requests agents made that wait
// for a person. The daemon holds them in memory for 10 minutes.

import type { Command } from "commander";
import { globalOutput, printList, printMutation, resolveFormat, type OutputFormat } from "../ui/output";
import type { ApprovalView } from "../tunnels/approvals";
import { connectToDaemon, DaemonError } from "../tunnels/control-client";
import { formatExpiry } from "./tunnel-saved";

export function approvalRows(items: ApprovalView[], now: number, all: boolean): Array<Record<string, string>> {
  return items.map((a) => ({
    id: a.id,
    agent: a.agent,
    action: a.action,
    description: a.description,
    ...(all ? { status: a.status } : {}),
    expires: a.status === "pending" ? formatExpiry(a.expires_at, now) : "",
  }));
}

export function formatApprovals(items: ApprovalView[], fmt: OutputFormat, all: boolean, now = Date.now()): void {
  if (fmt === "json") {
    for (const a of items) process.stdout.write(JSON.stringify(a) + "\n");
    return;
  }
  if (items.length === 0) {
    process.stdout.write(all ? "no approvals\n" : "no pending approvals\n");
    return;
  }
  printList(
    approvalRows(items, now, all),
    [
      { key: "id", label: "ID" },
      { key: "agent", label: "AGENT" },
      { key: "action", label: "ACTION" },
      { key: "description", label: "REQUEST" },
      ...(all ? [{ key: "status", label: "STATUS" }] : []),
      { key: "expires", label: "EXPIRES" },
    ],
    fmt,
  );
}

function fail(err: unknown): never {
  console.error(`tunnel: ${err instanceof Error ? err.message : String(err)}`);
  const code = (err as { exitCode?: unknown } | null)?.exitCode;
  process.exit(typeof code === "number" ? code : 1);
}

export function registerTunnelApprovals(tunnelCmd: Command, program: Command): void {
  tunnelCmd
    .command("approvals")
    .description("list the requests agents made that wait for approval")
    .option("--all", "include approvals decided in the last hour", false)
    .action(async (opts: { all?: boolean }) => {
      const fmt = resolveFormat(globalOutput(program));
      try {
        const client = await connectToDaemon({ autoStart: false });
        formatApprovals(await client.approvals(opts.all === true), fmt, opts.all === true);
      } catch (err) {
        if (err instanceof DaemonError && err.code === "not_running") {
          formatApprovals([], fmt, opts.all === true);
          return;
        }
        fail(err);
      }
    });

  for (const verb of ["approve", "deny"] as const) {
    tunnelCmd
      .command(`${verb} <id>`)
      .description(
        verb === "approve"
          ? "approve an agent's request; the daemon then runs it"
          : "deny an agent's request",
      )
      .action(async (id: string) => {
        try {
          const client = await connectToDaemon({ autoStart: false });
          const done = verb === "approve" ? await client.approve(id) : await client.deny(id);
          printMutation(program, done as unknown as Record<string, unknown>, `tunnel: ${done.status} ${done.id}: ${done.description}`);
          if (done.error) {
            console.error(`tunnel: approved, but the request failed: ${done.error.message}`);
            process.exit(1);
          }
        } catch (err) {
          fail(err);
        }
      });
  }
}
