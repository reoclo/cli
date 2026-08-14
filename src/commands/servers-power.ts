// src/commands/servers-power.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveServer } from "../client/resolve";
import { withCompletion } from "../client/command-meta";
import { globalOutput, printMutation, printObject, resolveFormat } from "../ui/output";
import { promptYesNo } from "../ui/prompt";
import { ApiError } from "../client/errors";

export type PowerAction = "on" | "off" | "shutdown" | "reboot" | "reset";

/** Map a CLI action name onto its `/cloud/<suffix>` endpoint. */
export const POWER_ENDPOINT: Record<PowerAction, string> = {
  on: "power-on",
  off: "power-off",
  shutdown: "shutdown",
  reboot: "reboot",
  reset: "reset",
};

/** Actions that interrupt the server prompt for confirmation before dispatch. */
export function powerNeedsConfirm(action: PowerAction): boolean {
  return action !== "on";
}

/** The provider power state a completed action should settle into. `reboot` and
 *  `reset` return to `running`; their start and end states are both `running`,
 *  so `--wait` confirms the server is `running` after a settle rather than
 *  reliably catching the full down-then-up cycle. */
export function targetStateFor(action: PowerAction): "running" | "stopped" {
  return action === "off" || action === "shutdown" ? "stopped" : "running";
}

/** Advisory hint appended (to stderr) for the error statuses where the user can
 *  act. Returns null for statuses that already carry a clear backend detail. */
export function powerErrorHint(status: number): string | null {
  if (status === 422) {
    return "This provider does not support that operation. Run 'reoclo servers power capabilities <server>' to see what it supports.";
  }
  if (status === 400) {
    return "This server may not be cloud-managed. Run 'reoclo servers power capabilities <server>' to check.";
  }
  if (status === 409) {
    return "Another power action is already in progress on this server. Try again shortly.";
  }
  return null;
}

export interface PollResult {
  reached: boolean;
  lastState: string | null;
}

/** Poll `statusFn` up to `attempts` times, sleeping `sleepMs` between tries,
 *  until it returns `target`. `sleep` is injectable so tests run instantly. */
export async function pollUntilState(opts: {
  statusFn: () => Promise<string | null>;
  target: string;
  attempts: number;
  sleepMs: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PollResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: string | null = null;
  for (let i = 0; i < opts.attempts; i++) {
    last = await opts.statusFn();
    if (last === opts.target) return { reached: true, lastState: last };
    if (i < opts.attempts - 1) await sleep(opts.sleepMs);
  }
  return { reached: false, lastState: last };
}

export interface ActionResponse {
  operation_id: string | null;
  strategy: string;
  execution_path: string;
  fallback_used: boolean;
  fallback_reason: string | null;
  status: string;
  reason: string;
}

export interface StatusCheckResponse {
  provider_status: string | null;
  last_synced_at: string | null;
}

export interface CapabilitiesResponse {
  provider: string | null;
  capabilities: string[];
  cloud_configured: boolean;
}

interface PowerActionOpts {
  yes?: boolean;
  wait?: boolean;
  waitTimeout?: string;
}

const POLL_INTERVAL_MS = 3000;
const DEFAULT_WAIT_SECONDS = 120;

const ACTION_VERB: Record<PowerAction, string> = {
  on: "Power on",
  off: "Power off",
  shutdown: "Shut down",
  reboot: "Reboot",
  reset: "Reset",
};

const ACTION_DESC: Record<PowerAction, string> = {
  on: "power on a stopped server through its cloud provider",
  off: "power off a server through its cloud provider (hard power cut)",
  shutdown: "gracefully shut down a server through its cloud provider",
  reboot:
    "reboot a server through its cloud provider (distinct from the runner-based 'servers reboot')",
  reset: "hard-reset a server through its cloud provider",
};

async function runPowerAction(
  program: Command,
  action: PowerAction,
  idOrSlug: string,
  opts: PowerActionOpts,
): Promise<void> {
  const ctx = await bootstrap();
  const tid = await requireTenantId(ctx);
  const sid = await resolveServer(ctx.client, tid, idOrSlug);

  if (powerNeedsConfirm(action) && !opts.yes) {
    const ok = await promptYesNo(
      `${ACTION_VERB[action]} server '${idOrSlug}' through its cloud provider? [y/N] `,
    );
    if (!ok) {
      process.stderr.write("aborted (pass --yes to skip this prompt)\n");
      const err = new Error("power action aborted") as Error & { exitCode: number };
      err.exitCode = 1;
      throw err;
    }
  }

  const path = `/tenants/${tid}/servers/${sid}/cloud/${POWER_ENDPOINT[action]}`;
  let res: ActionResponse;
  try {
    res = await ctx.client.post<ActionResponse>(path);
  } catch (e) {
    if (e instanceof ApiError) {
      const hint = powerErrorHint(e.status);
      if (hint) process.stderr.write(`${hint}\n`);
    }
    throw e;
  }

  printMutation(
    program,
    res as unknown as Record<string, unknown>,
    `✓ ${POWER_ENDPOINT[action]} dispatched: ${idOrSlug}`,
  );
  if (res.reason) process.stdout.write(`  ${res.reason}\n`);

  if (opts.wait) {
    const target = targetStateFor(action);
    const timeoutSeconds = opts.waitTimeout
      ? Number.parseInt(opts.waitTimeout, 10)
      : DEFAULT_WAIT_SECONDS;
    const attempts = Math.max(1, Math.ceil((timeoutSeconds * 1000) / POLL_INTERVAL_MS));
    process.stderr.write(
      `waiting for '${idOrSlug}' to reach '${target}' (up to ${timeoutSeconds}s)...\n`,
    );
    const { reached, lastState } = await pollUntilState({
      statusFn: async () => {
        const s = await ctx.client.post<StatusCheckResponse>(
          `/tenants/${tid}/servers/${sid}/cloud/status`,
        );
        return s.provider_status ?? null;
      },
      target,
      attempts,
      sleepMs: POLL_INTERVAL_MS,
    });
    if (!reached) {
      process.stderr.write(
        `timed out after ${timeoutSeconds}s; last observed state: ${lastState ?? "unknown"}\n`,
      );
      const err = new Error(`server did not reach '${target}'`) as Error & { exitCode: number };
      err.exitCode = 1;
      throw err;
    }
    process.stdout.write(`✓ '${idOrSlug}' is now '${target}'\n`);
  }
}

export function registerServersPower(program: Command, serversGroup: Command): void {
  const power = serversGroup
    .command("power")
    .description("cloud provider power operations (only on cloud-managed servers)");

  const actions: PowerAction[] = ["on", "off", "shutdown", "reboot", "reset"];
  for (const action of actions) {
    const cmd = power
      .command(`${action} <idOrSlug>`)
      .description(ACTION_DESC[action])
      .option("--wait", "block until the server reaches its target power state")
      .option(
        "--wait-timeout <seconds>",
        `how long --wait polls before giving up (default ${DEFAULT_WAIT_SECONDS})`,
      );
    if (powerNeedsConfirm(action)) {
      cmd.option("--yes", "skip the confirmation prompt");
    }
    cmd.action((idOrSlug: string, opts: PowerActionOpts) =>
      runPowerAction(program, action, idOrSlug, opts),
    );
    withCompletion(cmd, { args: [{ slot: 0, resource: "servers" }] });
  }

  const statusCmd = power
    .command("status <idOrSlug>")
    .description("show a server's live cloud provider power state")
    .action(async (idOrSlug: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const sid = await resolveServer(ctx.client, tid, idOrSlug);
      const res = await ctx.client.post<StatusCheckResponse>(
        `/tenants/${tid}/servers/${sid}/cloud/status`,
      );
      printObject(res as unknown as Record<string, unknown>, fmt);
    });
  withCompletion(statusCmd, { args: [{ slot: 0, resource: "servers" }] });

  const capsCmd = power
    .command("capabilities <idOrSlug>")
    .description("list the cloud power operations this server's provider supports")
    .action(async (idOrSlug: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const sid = await resolveServer(ctx.client, tid, idOrSlug);
      const res = await ctx.client.get<CapabilitiesResponse>(
        `/tenants/${tid}/servers/${sid}/cloud/capabilities`,
      );
      printObject(res as unknown as Record<string, unknown>, fmt);
    });
  withCompletion(capsCmd, { args: [{ slot: 0, resource: "servers" }] });
}
