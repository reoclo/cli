// src/commands/servers-network.ts
//
// `servers network show|set|reapply`: whether a server takes public traffic or
// only traffic through `reoclo tunnel`. Needs a connected runner, which applies
// the firewall; the API records the intent and the runner reports back, so a
// change answers "applying" and settles a moment later.
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveServer } from "../client/resolve";
import { withCompletion } from "../client/command-meta";
import { ApiError } from "../client/errors";
import {
  describeBlockers,
  serviceTunnels,
  type NetworkAccess,
  type NetworkAccessBlocker,
  type NetworkAccessMode,
} from "../client/network-access";
import { globalOutput, printList, printMutation, printObject, resolveFormat } from "../ui/output";
import { confirmOrExit } from "../ui/prompt";
import { badUsage } from "../util/parse-flag";

const CONFLICT_TEXT: Record<string, string> = {
  runner_required:
    "network access needs a runner, and this server connects over SSH. Install the runner first.",
  runner_outdated:
    "this server's runner is too old to change network access. Update the runner, then try again.",
};

export function parseNetworkMode(raw: string): NetworkAccessMode {
  if (raw === "public") return "public";
  if (raw === "tunnels-only" || raw === "tunnels_only") return "tunnels_only";
  throw badUsage(`invalid mode '${raw}' (use public or tunnels-only)`);
}

/** Turn the API's 409 codes into a message a person can act on. Anything else
 *  passes through unchanged. */
export async function explainConflict(
  error: unknown,
  readBlockers: () => Promise<NetworkAccessBlocker[]>,
): Promise<unknown> {
  if (!(error instanceof ApiError) || error.status !== 409) return error;
  if (error.message === "network_access_blocked") {
    const blockers = describeBlockers(await readBlockers().catch(() => []));
    const hint =
      blockers.length > 0
        ? `Remove these first:\n    - ${blockers.join("\n    - ")}`
        : "Run 'reoclo servers network show <server>' to see what blocks it.";
    return new ApiError(
      409,
      "cannot switch to tunnels-only while something still needs public access",
      error.path,
      hint,
    );
  }
  const text = CONFLICT_TEXT[error.message];
  return text === undefined ? error : new ApiError(409, text, error.path);
}

function printNetworkAccess(server: string, access: NetworkAccess, fmt: ReturnType<typeof resolveFormat>): void {
  const tunnels = serviceTunnels(server, access.services);
  if (fmt === "json" || fmt === "yaml") {
    printObject({ ...access, tunnel_commands: tunnels }, fmt);
    return;
  }
  const summary: Record<string, unknown> = {
    mode: access.mode,
    status: access.status,
    changed_at: access.changed_at,
    applied_at: access.applied_at,
  };
  if (access.error) summary["error"] = access.error;
  if (!access.supported) summary["unsupported"] = access.unsupported_reason;
  printObject(summary, "text");

  if (access.drift_reasons.length > 0) {
    process.stdout.write("\ndrift:\n");
    for (const r of access.drift_reasons) {
      process.stdout.write(`  ${r.code}${r.detail ? `: ${r.detail}` : ""}\n`);
    }
  }

  const probe = access.last_probe;
  if (probe) {
    const outcome = probe.skipped_reason
      ? `skipped (${probe.skipped_reason})`
      : `${probe.open_ports.length} open of ${probe.ports_checked.length} checked${
          probe.open_ports.length > 0 ? `: ${probe.open_ports.join(", ")}` : ""
        }`;
    process.stdout.write(`\nlast probe: ${probe.probed_at} from ${probe.address ?? "unknown"}, ${outcome}\n`);
  }

  if (access.blockers.length > 0) {
    process.stdout.write("\nblocks tunnels-only:\n");
    for (const line of describeBlockers(access.blockers)) process.stdout.write(`  ${line}\n`);
  }

  if (tunnels.length > 0) {
    process.stdout.write("\nlistening services:\n");
    printList(
      tunnels as unknown as Array<Record<string, unknown>>,
      [
        { key: "port", label: "PORT" },
        { key: "protocol", label: "PROTO" },
        { key: "process", label: "PROCESS" },
        { key: "command", label: "TUNNEL" },
      ],
      fmt,
    );
  }
}

export function registerServersNetwork(program: Command, serversGroup: Command): void {
  const network = serversGroup
    .command("network")
    .description("control whether a server takes public traffic or only traffic through 'reoclo tunnel'");

  withCompletion(
    network
      .command("show <idOrSlug>")
      .description("show a server's network access: status, drift, last probe, blockers and tunnel commands")
      .action(async (idOrSlug: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const sid = await resolveServer(ctx.client, tid, idOrSlug);
        const access = await ctx.client.get<NetworkAccess>(`/tenants/${tid}/servers/${sid}/network-access`);
        printNetworkAccess(idOrSlug, access, fmt);
      }),
    { args: [{ slot: 0, resource: "servers" }] },
  );

  withCompletion(
    network
      .command("set <idOrSlug> <mode>")
      .description("set network access to 'public' or 'tunnels-only' (needs a runner server)")
      .option("--yes", "skip the confirmation prompt")
      .action(async (idOrSlug: string, rawMode: string, opts: { yes?: boolean }) => {
        const mode = parseNetworkMode(rawMode);
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const sid = await resolveServer(ctx.client, tid, idOrSlug);
        const path = `/tenants/${tid}/servers/${sid}/network-access`;
        await confirmOrExit(
          mode === "tunnels_only"
            ? `Make '${idOrSlug}' tunnels-only? The firewall closes every inbound port, including SSH. Reach it with 'reoclo tunnel'. [y/N] `
            : `Make '${idOrSlug}' public again? Reoclo restores the inbound firewall rules it saved. [y/N] `,
          opts.yes,
        );
        let res: NetworkAccess;
        try {
          res = await ctx.client.put<NetworkAccess>(path, { mode });
        } catch (error: unknown) {
          throw await explainConflict(error, async () => (await ctx.client.get<NetworkAccess>(path)).blockers);
        }
        printMutation(
          program,
          res as unknown as Record<string, unknown>,
          `✓ network access set to ${mode === "tunnels_only" ? "tunnels-only" : "public"}: ${idOrSlug} (${res.status})`,
        );
        if (res.status === "applying") {
          process.stdout.write(`  Check progress with: reoclo servers network show ${idOrSlug}\n`);
        }
      }),
    { args: [{ slot: 0, resource: "servers" }] },
  );

  withCompletion(
    network
      .command("reapply <idOrSlug>")
      .description("apply the server's network access again, for a drifted or failed server")
      .action(async (idOrSlug: string) => {
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const sid = await resolveServer(ctx.client, tid, idOrSlug);
        const path = `/tenants/${tid}/servers/${sid}/network-access`;
        let res: NetworkAccess;
        try {
          res = await ctx.client.post<NetworkAccess>(`${path}/reapply`);
        } catch (error: unknown) {
          throw await explainConflict(error, async () => (await ctx.client.get<NetworkAccess>(path)).blockers);
        }
        printMutation(
          program,
          res as unknown as Record<string, unknown>,
          `✓ network access is being applied again: ${idOrSlug} (${res.status})`,
        );
      }),
    { args: [{ slot: 0, resource: "servers" }] },
  );
}
