import { describe, expect, it } from "bun:test";
import { callerOf, gateAdd, gateCa, gateEdit, gateRemove, gateShare, gateUnshare, gateUp } from "../../../src/tunnels/gating";
import type { TunnelView } from "../../../src/tunnels/manager";

const view = (extra: Partial<TunnelView> = {}): TunnelView => ({
  name: "t",
  org: "acme",
  server: "prod-1",
  server_id: "s1",
  kind: "tcp",
  keep_up: false,
  enabled: true,
  via: "reoclo",
  path: "relay",
  state: "ready",
  message: "",
  action: "None",
  traffic: { bytes_in: 0, bytes_out: 0, streams: 0 },
  ...extra,
});

describe("callerOf", () => {
  it("reads the client and the agent from the headers", () => {
    expect(callerOf(new Headers({ "x-reoclo-client": "mcp", "x-reoclo-agent": "claude-code" }))).toEqual({
      client: "mcp",
      agent: "claude-code",
    });
  });

  it("reports an unknown client when the header is missing", () => {
    expect(callerOf(new Headers())).toEqual({ client: "unknown" });
  });
});

describe("gateAdd", () => {
  it("lets plain tcp and udp tunnels through", () => {
    expect(gateAdd({ name: "db", kind: "tcp", target: "127.0.0.1:5432", server: "prod-1" })).toBeUndefined();
    expect(gateAdd({ name: "dns", kind: "udp", target: "127.0.0.1:53", server: "prod-1" })).toBeUndefined();
  });

  it("gates reverse, public bind, share and hostname tunnels", () => {
    const reverse = gateAdd({ name: "hook", kind: "reverse", server: "prod-1", remote_port: 8080, local_target: "127.0.0.1:3000" });
    expect(reverse).toMatchObject({ action: "save_tunnel" });
    expect(reverse?.description).toContain("reverse tunnel");
    expect(gateAdd({ name: "a", kind: "tcp", bind_public: true })).toBeDefined();
    expect(gateAdd({ name: "a", kind: "tcp", share: { tailnet: true } })).toBeDefined();
    expect(gateAdd({ name: "a", kind: "tcp", hostname: "db.prod-1.reoclo.localhost" })).toBeDefined();
    expect(gateAdd({ name: "grafana", kind: "https", target: "127.0.0.1:3000" })).toBeDefined();
  });

  it("does not fail on a body that is not an object", () => {
    expect(gateAdd("nope")).toBeUndefined();
    expect(gateAdd(null)).toBeUndefined();
  });
});

describe("gateEdit", () => {
  it("lets a plain change to a plain tunnel through", () => {
    expect(gateEdit(view(), { target: "10.0.0.1:80" })).toBeUndefined();
    expect(gateEdit(view({ hostname: "a.reoclo.localhost" }), { hostname: "a.reoclo.localhost" })).toBeUndefined();
  });

  it("gates any change to a reverse or public tunnel", () => {
    expect(gateEdit(view({ kind: "reverse" }), { remote_port: 9000 })).toBeDefined();
    expect(gateEdit(view({ bind_public: true }), { target: "10.0.0.1:80" })).toBeDefined();
  });

  it("gates setting or moving a hostname, and widening the bind", () => {
    expect(gateEdit(view(), { hostname: "db.prod-1.reoclo.localhost" })?.description).toContain("hostname");
    expect(gateEdit(view({ hostname: "a.reoclo.localhost" }), { hostname: "b.reoclo.localhost" })).toBeDefined();
    expect(gateEdit(view(), { bind_public: true })).toBeDefined();
  });
});

describe("gateUp and gateRemove", () => {
  it("gates bringing up a reverse or public tunnel only", () => {
    expect(gateUp(view())).toBeUndefined();
    expect(gateUp(view({ kind: "reverse" }))).toMatchObject({ action: "open_tunnel" });
    expect(gateUp(view({ bind_public: true }))).toBeDefined();
  });

  it("gates removing a tunnel that owns a hostname", () => {
    expect(gateRemove(view())).toBeUndefined();
    expect(gateRemove(view({ hostname: "a.reoclo.localhost" }))).toMatchObject({ action: "remove_tunnel" });
  });
});

describe("gateCa", () => {
  it("names trust and untrust", () => {
    expect(gateCa("trust").action).toBe("trust_ca");
    expect(gateCa("untrust").action).toBe("untrust_ca");
  });
});

describe("gateShare and gateUnshare", () => {
  it("names the tunnel, the server and the port a person is asked to approve", () => {
    expect(gateShare(view({ name: "db" }), { tailnet: true, port: 5432 })).toEqual({
      action: "share_tunnel",
      description: 'Share "db" to prod-1 on the tailnet on port 5432',
    });
    expect(gateShare(view({ name: "db" }), { tailnet: true }).description).toBe('Share "db" to prod-1 on the tailnet');
  });

  it("gates stopping a share as well", () => {
    expect(gateUnshare(view({ name: "db" }))).toEqual({ action: "unshare_tunnel", description: 'Stop sharing "db" on the tailnet' });
  });

  it("keeps gating a share given while saving or editing", () => {
    expect(gateAdd({ name: "db", kind: "tcp", target: "127.0.0.1:5432", server: "prod-1", share: { tailnet: true } })).toBeDefined();
    expect(gateEdit(view(), { share: { tailnet: true, port: 5432 } })).toBeDefined();
    expect(gateEdit(view(), { share: null })).toBeDefined();
  });

  it("does not gate changing the transport", () => {
    expect(gateEdit(view(), { via: "tailscale" })).toBeUndefined();
    expect(gateAdd({ name: "db", kind: "tcp", target: "127.0.0.1:5432", server: "prod-1", via: "auto" })).toBeUndefined();
  });
});
