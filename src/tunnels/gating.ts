// src/tunnels/gating.ts
//
// Which control API requests an agent may not make on its own. The caller is
// named by the X-Reoclo-Client header; the rule is a guardrail, not a boundary.

import type { TunnelView } from "./manager";

export interface Caller {
  client: string;
  agent?: string;
}

export function callerOf(headers: Headers): Caller {
  const agent = headers.get("x-reoclo-agent")?.trim();
  return { client: headers.get("x-reoclo-client")?.trim() || "unknown", ...(agent ? { agent } : {}) };
}

export interface Gate {
  action: string;
  description: string;
}

type Body = Record<string, unknown>;

function asBody(raw: unknown): Body {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Body) : {};
}

function str(v: unknown, fallback = "?"): string {
  return typeof v === "string" && v !== "" ? v : fallback;
}

/** Saving a tunnel is gated when it is reverse, bound publicly, shared, or owns a hostname. */
export function gateAdd(raw: unknown): Gate | undefined {
  const b = asBody(raw);
  const name = str(b["name"]);
  const server = str(b["server"]);
  if (b["kind"] === "reverse") {
    return {
      action: "save_tunnel",
      description: `Save reverse tunnel "${name}": ${server} port ${str(b["remote_port"])} to ${str(b["local_target"])} on this machine`,
    };
  }
  if (b["bind_public"] === true) {
    return { action: "save_tunnel", description: `Save tunnel "${name}" to ${server} bound on all interfaces` };
  }
  if (b["share"] !== undefined) {
    return { action: "save_tunnel", description: `Save tunnel "${name}" to ${server} shared on the tailnet` };
  }
  if (typeof b["hostname"] === "string" || b["kind"] === "https") {
    const host = typeof b["hostname"] === "string" ? ` with hostname ${b["hostname"]}` : " with a hostname";
    return { action: "save_tunnel", description: `Save ${str(b["kind"], "https")} tunnel "${name}" to ${server}${host}` };
  }
  return undefined;
}

function sensitive(t: TunnelView): string | undefined {
  if (t.kind === "reverse") return "reverse tunnel";
  if (t.bind_public === true) return "tunnel bound on all interfaces";
  return undefined;
}

/** Editing is gated for a sensitive tunnel, or any change that sets or moves a hostname or widens the bind. */
export function gateEdit(current: TunnelView, raw: unknown): Gate | undefined {
  const b = asBody(raw);
  const kind = sensitive(current);
  if (kind !== undefined) {
    return { action: "save_tunnel", description: `Change ${kind} "${current.name}" on ${current.server}` };
  }
  if ("hostname" in b && b["hostname"] !== current.hostname) {
    return {
      action: "save_tunnel",
      description: `Change the hostname of "${current.name}" from ${current.hostname ?? "none"} to ${str(b["hostname"], "none")}`,
    };
  }
  if (b["bind_public"] === true || b["share"] !== undefined) {
    return { action: "save_tunnel", description: `Widen who can reach "${current.name}" on ${current.server}` };
  }
  return undefined;
}

export function gateUp(current: TunnelView): Gate | undefined {
  const kind = sensitive(current);
  return kind === undefined
    ? undefined
    : { action: "open_tunnel", description: `Bring up ${kind} "${current.name}" on ${current.server}` };
}

/** Sharing widens who can reach the server, and stopping a share changes who can reach the tunnel: both need a person when an agent asks. */
export function gateShare(current: TunnelView, raw: unknown): Gate {
  const port = asBody(raw)["port"];
  const where = typeof port === "number" ? ` on port ${port}` : "";
  return { action: "share_tunnel", description: `Share "${current.name}" to ${current.server} on the tailnet${where}` };
}

export function gateUnshare(current: TunnelView): Gate {
  return { action: "unshare_tunnel", description: `Stop sharing "${current.name}" on the tailnet` };
}

export function gateRemove(current: TunnelView): Gate | undefined {
  if (current.hostname === undefined) return undefined;
  return { action: "remove_tunnel", description: `Remove tunnel "${current.name}" and its hostname ${current.hostname}` };
}

export function gateCa(verb: "trust" | "untrust"): Gate {
  return verb === "trust"
    ? { action: "trust_ca", description: "Trust the local certificate authority in the system trust store" }
    : { action: "untrust_ca", description: "Remove the local certificate authority from the system trust store and delete its key" };
}
