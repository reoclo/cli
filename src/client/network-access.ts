// src/client/network-access.ts
//
// Shapes and helpers for a server's network access: `public`, or `tunnels_only`
// (no inbound traffic, services reached through `reoclo tunnel`). Shared by the
// `servers network` commands and the MCP tools, and vendored into the hosted
// MCP, so it imports nothing.

export type NetworkAccessMode = "public" | "tunnels_only";

export type NetworkAccessStatus = "public" | "applying" | "enforced" | "drifted" | "failed";

export interface NetworkAccessBlocker {
  kind: "domain" | "managed_proxy" | "preview";
  label: string;
  href: string | null;
}

export interface NetworkAccessService {
  port: number;
  protocol: string;
  bind_address: string | null;
  process: string | null;
}

export interface NetworkAccessProbe {
  probed_at: string;
  address: string | null;
  ports_checked: number[];
  open_ports: number[];
  skipped_reason: string | null;
}

export interface NetworkAccess {
  mode: NetworkAccessMode;
  status: NetworkAccessStatus;
  state: string;
  changed_at: string | null;
  changed_by_user_id: string | null;
  applied_at: string | null;
  error: string | null;
  drift_reasons: Array<{ code: string; detail: string }>;
  last_probe: NetworkAccessProbe | null;
  port_scan_updated_at: string | null;
  blockers: NetworkAccessBlocker[];
  services: NetworkAccessService[];
  supported: boolean;
  unsupported_reason: "runner_required" | "runner_outdated" | null;
}

export interface ServiceTunnel {
  port: number;
  protocol: string;
  process: string | null;
  command: string;
}

/** The `reoclo tunnel` invocation that reaches one listening service from this
 *  machine, on the same local port. */
export function tunnelCommand(server: string, service: Pick<NetworkAccessService, "port" | "protocol">): string {
  const udp = service.protocol.toLowerCase() === "udp" ? " --udp" : "";
  return `reoclo tunnel ${server} -L ${service.port}:${service.port}${udp}`;
}

/** One tunnel command per listening port and protocol. A service bound on both
 *  IPv4 and IPv6 is listed once. */
export function serviceTunnels(server: string, services: NetworkAccessService[]): ServiceTunnel[] {
  const seen = new Set<string>();
  const tunnels: ServiceTunnel[] = [];
  for (const s of services) {
    const key = `${s.port}/${s.protocol.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tunnels.push({
      port: s.port,
      protocol: s.protocol.toLowerCase(),
      process: s.process,
      command: tunnelCommand(server, s),
    });
  }
  return tunnels;
}

/** One line per blocker, for error hints. */
export function describeBlockers(blockers: NetworkAccessBlocker[]): string[] {
  return blockers.map((b) => `${b.kind}: ${b.label}`);
}
