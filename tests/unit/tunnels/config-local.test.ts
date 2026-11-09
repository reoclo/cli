import { describe, expect, it } from "bun:test";
import { ConfigError, emptyConfig, parseConfig, parseTunnel } from "../../../src/tunnels/config";
import { messageOf } from "../../helpers/rejection";

function captured(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

const local: Record<string, unknown> = {
  name: "app",
  kind: "local",
  hostname: "app.reoclo.localhost",
  local_target: "127.0.0.1:48080",
};
const https: Record<string, unknown> = {
  name: "grafana",
  org: "acme",
  tenant_id: "t1",
  server: "prod-1",
  server_id: "s1",
  kind: "https",
  target: "127.0.0.1:3000",
  hostname: "app.reoclo.localhost",
};

describe("a local tunnel in the config schema", () => {
  it("accepts a route and applies the defaults", () => {
    expect(parseTunnel(local)).toEqual({
      name: "app",
      kind: "local",
      hostname: "app.reoclo.localhost",
      local_target: "127.0.0.1:48080",
      enabled: true,
      keep_up: false,
    });
  });

  it("rejects fields that belong to a server tunnel", () => {
    for (const extra of [{ org: "acme" }, { tenant_id: "t1" }, { profile: "p" }, { server: "s" }, { server_id: "s1" }, { via: "reoclo" }, { share: { tailnet: true, port: 443 } }]) {
      expect(captured(() => parseTunnel({ ...local, ...extra }))).toBeInstanceOf(ConfigError);
    }
  });

  it("requires a hostname and a local target", () => {
    expect(captured(() => parseTunnel({ ...local, hostname: undefined }))).toBeInstanceOf(ConfigError);
    expect(captured(() => parseTunnel({ ...local, local_target: undefined }))).toBeInstanceOf(ConfigError);
    expect(captured(() => parseTunnel({ ...local, local_target: "5432" }))).toBeInstanceOf(ConfigError);
  });

  it("applies the allowed-suffix rule to the hostname", () => {
    const base = emptyConfig();
    const bad = captured(() => parseConfig({ ...base, tunnels: [{ ...local, hostname: "app.reoclo.test" }] }));
    expect(messageOf(bad)).toContain("must end in");
    const ok = parseConfig({ ...base, ca_suffixes: ["reoclo.test"], tunnels: [{ ...local, hostname: "app.reoclo.test" }] });
    expect(ok.tunnels[0]).toMatchObject({ kind: "local", hostname: "app.reoclo.test" });
  });

  it("rejects a hostname an https tunnel already uses, in either order", () => {
    for (const tunnels of [[https, local], [local, https]]) {
      const err = captured(() => parseConfig({ ...emptyConfig(), tunnels }));
      expect(messageOf(err)).toContain("is already used by");
    }
  });
});
