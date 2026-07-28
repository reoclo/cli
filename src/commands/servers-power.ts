// src/commands/servers-power.ts

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
