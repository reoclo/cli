// src/tunnels/states.ts
//
// The states a saved tunnel can be in, how a gateway close code maps onto them,
// and the message and suggested action every surface (CLI, app, MCP) shows.

export type TunnelState =
  | "down"
  | "ready"
  | "connecting"
  | "active"
  | "reconnecting"
  | "needs_sign_in"
  | "server_offline"
  | "quota_reached"
  | "expired"
  | "closed_by_operator"
  | "forbidden"
  | "failed";

/** States that mean the session could not be opened or was lost for good. */
export type FailureState = Extract<
  TunnelState,
  | "needs_sign_in"
  | "server_offline"
  | "quota_reached"
  | "expired"
  | "closed_by_operator"
  | "forbidden"
  | "failed"
>;

export const TUNNEL_STATES: readonly TunnelState[] = [
  "down",
  "ready",
  "connecting",
  "active",
  "reconnecting",
  "needs_sign_in",
  "server_offline",
  "quota_reached",
  "expired",
  "closed_by_operator",
  "forbidden",
  "failed",
];

/** Close codes the daemon passes to TunnelSession as extra fatal codes. */
export const CLOSE_BY_OPERATOR = 4407;
export const CLOSE_MAX_DURATION = 4408;
export const DAEMON_FATAL_CODES: number[] = [CLOSE_BY_OPERATOR, CLOSE_MAX_DURATION];

export interface StateInfo {
  message: string;
  action: string;
}

export const STATE_INFO: Record<TunnelState, StateInfo> = {
  down: { message: "Tunnel is down", action: "Run reoclo tunnel up <name>" },
  ready: { message: "Listening, no session open", action: "None" },
  connecting: { message: "Opening the session", action: "None" },
  active: { message: "Session open", action: "None" },
  reconnecting: { message: "Session dropped, retrying", action: "None" },
  needs_sign_in: { message: "Sign-in expired", action: "Run reoclo login" },
  server_offline: { message: "The server's runner is not connected", action: "Retry later" },
  quota_reached: { message: "Concurrent tunnel limit reached", action: "Close another tunnel" },
  expired: {
    message: "Session reached the maximum duration",
    action: "Run reoclo tunnel up <name>",
  },
  closed_by_operator: {
    message: "Session was closed by an operator",
    action: "Run reoclo tunnel up <name>",
  },
  forbidden: { message: "The server refused the tunnel", action: "Ask an org admin" },
  failed: { message: "The tunnel failed", action: "See the detail" },
};

/** States that stay until someone runs `up` again; the daemon never leaves them on its own. */
export function isStickyState(s: TunnelState): boolean {
  return s === "expired" || s === "closed_by_operator";
}

export function isFailureState(s: TunnelState): s is FailureState {
  return (
    s === "needs_sign_in" ||
    s === "server_offline" ||
    s === "quota_reached" ||
    s === "expired" ||
    s === "closed_by_operator" ||
    s === "forbidden" ||
    s === "failed"
  );
}

/** Map a gateway close code onto a tunnel state. */
export function stateForCloseCode(code: number | undefined): FailureState {
  switch (code) {
    case 4401:
      return "needs_sign_in";
    case 4410:
    case 4502:
      return "server_offline";
    case 4429:
      return "quota_reached";
    case CLOSE_MAX_DURATION:
      return "expired";
    case CLOSE_BY_OPERATOR:
      return "closed_by_operator";
    case 4403:
    case 4404:
    case 4409:
      return "forbidden";
    default:
      return "failed";
  }
}

/**
 * Map an error thrown while opening a session onto a state. The WebSocket
 * client reports an upgrade the gateway refused as "Unexpected server response:
 * <status>", and bootstrap() throws ReauthRequiredError when the stored session
 * cannot be refreshed.
 */
export function stateForConnectError(err: unknown): { state: FailureState; detail: string } {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  if (name === "ReauthRequiredError") return { state: "needs_sign_in", detail: message };
  // bootstrap() failures carry an exit code: 3 is "not authenticated", 5 is an
  // org the profile was never granted. A rejected tenant_switch grant says which
  // of the two it is by its HTTP status.
  const exitCode = (err as { exitCode?: unknown } | null)?.exitCode;
  if (exitCode === 3) return { state: "needs_sign_in", detail: message };
  if (exitCode === 5) return { state: "forbidden", detail: message };
  if (name === "TenantSwitchError") {
    const status = (err as { status?: unknown }).status;
    return { state: status === 403 ? "forbidden" : "needs_sign_in", detail: message };
  }
  const status = /Unexpected server response: (\d+)/.exec(message)?.[1];
  switch (status) {
    case "401":
      return { state: "needs_sign_in", detail: message };
    case "403":
    case "404":
    case "409":
      return { state: "forbidden", detail: message };
    case "429":
      return { state: "quota_reached", detail: message };
    case "502":
      return { state: "server_offline", detail: message };
    default:
      return { state: "failed", detail: message };
  }
}

export interface StateReport {
  state: TunnelState;
  message: string;
  action: string;
  /** The gateway's reason or the local error, when there is one. */
  detail?: string;
}

export function reportFor(state: TunnelState, detail?: string): StateReport {
  const info = STATE_INFO[state];
  return { state, message: info.message, action: info.action, ...(detail ? { detail } : {}) };
}
