import { describe, expect, it, spyOn } from "bun:test";
import { buildAddBody, buildEditBody, formatSavedTunnels, UsageError } from "../../../src/commands/tunnel-saved";
import { gateAdd, gateEdit } from "../../../src/tunnels/gating";
import type { TunnelView } from "../../../src/tunnels/manager";

const ctx = { org: "acme", tenant_id: "t1", profile: "default", server: "prod-1", server_id: "s1" };
const flags = { kind: "local", hostname: "App.Reoclo.Test", localTarget: "48080" };

describe("buildAddBody for a local route", () => {
  it("needs no server context and builds only the local fields", () => {
    expect(buildAddBody("app", flags)).toEqual({
      name: "app",
      kind: "local",
      hostname: "app.reoclo.test",
      local_target: "127.0.0.1:48080",
      enabled: true,
    });
    expect(buildAddBody("app", { ...flags, localTarget: "10.0.0.2:80", up: false })).toMatchObject({ local_target: "10.0.0.2:80", enabled: false });
  });

  it("rejects --server, --target, --via and the other server flags", () => {
    for (const [extra, flag] of [
      [{ server: "prod-1" }, "--server"],
      [{ target: "5432" }, "--target"],
      [{ via: "reoclo" }, "--via"],
      [{ tailnetHost: "box" }, "--tailnet-host"],
      [{ keepUp: true }, "--keep-up"],
      [{ localPort: "1" }, "--local-port"],
    ] as const) {
      const err = (() => {
        try {
          buildAddBody("app", { ...flags, ...extra });
        } catch (e) {
          return e;
        }
        return undefined;
      })();
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).message).toBe(`${flag} does not apply to a local tunnel`);
      expect((err as UsageError).exitCode).toBe(2);
    }
  });

  it("needs --hostname and --local-target", () => {
    expect(() => buildAddBody("app", { kind: "local", localTarget: "80" })).toThrow(/needs --hostname/);
    expect(() => buildAddBody("app", { kind: "local", hostname: "a.reoclo.test" })).toThrow(/needs --local-target/);
  });

  it("still needs a server context for every other kind", () => {
    for (const kind of ["tcp", "udp", "https", "reverse"]) {
      expect(() => buildAddBody("a", { kind, target: "80" })).toThrow(new RegExp(`a ${kind} tunnel needs --server`));
    }
    expect(buildAddBody("a", { target: "80" }, ctx)).toMatchObject({ kind: "tcp", server: "prod-1" });
  });

  it("lists local among the kinds", () => {
    expect(() => buildAddBody("a", { kind: "icmp", target: "80" }, ctx)).toThrow(/expected tcp, udp, https, reverse or local/);
  });
});

describe("buildEditBody for a local route", () => {
  it("changes the hostname and local target", () => {
    expect(buildEditBody("local", { hostname: "web.reoclo.test", localTarget: "9000" })).toEqual({
      hostname: "web.reoclo.test",
      local_target: "127.0.0.1:9000",
    });
  });

  it("rejects server, target and transport flags", () => {
    expect(() => buildEditBody("local", { server: "prod-1" })).toThrow(/--server does not apply to a local tunnel/);
    expect(() => buildEditBody("local", { target: "1" })).toThrow(UsageError);
    expect(() => buildEditBody("local", { via: "auto" })).toThrow(UsageError);
  });
});

const view: TunnelView = {
  name: "app",
  org: "",
  server: "",
  server_id: "",
  kind: "local",
  keep_up: false,
  enabled: true,
  state: "active",
  message: "",
  action: "None",
  url: "https://app.reoclo.test",
  hostname: "app.reoclo.test",
  local_target: "127.0.0.1:48080",
  traffic: { bytes_in: 0, bytes_out: 0, streams: 0 },
  via: "reoclo",
  path: "relay",
} as unknown as TunnelView;

describe("status and gating for a local route", () => {
  it("shows server local, the URL and the local target", () => {
    const written: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      formatSavedTunnels([view], "text");
    } finally {
      spy.mockRestore();
    }
    const out = written.join("");
    expect(out).toContain("local");
    expect(out).toContain("https://app.reoclo.test");
    expect(out).toContain("127.0.0.1:48080");
  });

  it("gates an agent adding or editing a local route", () => {
    const add = gateAdd({ name: "app", kind: "local", hostname: "app.reoclo.test", local_target: "127.0.0.1:48080" });
    expect(add?.action).toBe("save_tunnel");
    expect(add?.description).toContain("app.reoclo.test");
    expect(gateEdit(view, { local_target: "127.0.0.1:1" })?.action).toBe("save_tunnel");
    expect(gateEdit(view, { hostname: "other.reoclo.test" })?.action).toBe("save_tunnel");
    expect(gateEdit(view, { enabled: false })).toBeUndefined();
  });
});
