import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  emptyConfig,
  loadConfig,
  parseConfig,
  parseTunnel,
  saveConfig,
  updateConfig,
} from "../../../src/tunnels/config";
import { messageOf, rejectionOf } from "../../helpers/rejection";

function captured(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

const base = {
  name: "prod-db",
  org: "acme",
  tenant_id: "0192-t",
  server: "prod-1",
  server_id: "0192-s",
};
const forward: Record<string, unknown> = { ...base, kind: "tcp", target: "127.0.0.1:5432", local_port: 15432 };
const reverse: Record<string, unknown> = { ...base, name: "hook", kind: "reverse", remote_port: 8080, local_target: "127.0.0.1:3000" };

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reoclo-tunnels-cfg-"));
  file = join(dir, "tunnels", "tunnels.yaml");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("parseTunnel", () => {
  it("accepts a forward tunnel and fills defaults", () => {
    expect<unknown>(parseTunnel(forward)).toEqual({ ...forward, keep_up: false, enabled: true });
  });

  it("accepts a udp tunnel and a reverse tunnel", () => {
    expect(parseTunnel({ ...forward, kind: "udp" }).kind).toBe("udp");
    expect(parseTunnel(reverse)).toMatchObject({ kind: "reverse", bind_public: false, enabled: true });
  });

  it("rejects bad names", () => {
    for (const name of ["", "Prod", "-db", "a_b", "a".repeat(64)]) {
      expect(() => parseTunnel({ ...forward, name })).toThrow(ConfigError);
    }
    expect(parseTunnel({ ...forward, name: "a".repeat(63) }).name).toHaveLength(63);
  });

  it("rejects a malformed target and out-of-range ports", () => {
    expect(() => parseTunnel({ ...forward, target: "5432" })).toThrow(/HOST:PORT/);
    expect(() => parseTunnel({ ...forward, target: "db:99999" })).toThrow(/port/);
    expect(() => parseTunnel({ ...forward, local_port: 0 })).toThrow(ConfigError);
    expect(() => parseTunnel({ ...reverse, remote_port: 70000 })).toThrow(ConfigError);
  });

  it("requires a local port on a forward tunnel and the reverse fields on a reverse tunnel", () => {
    const noPort = { ...forward };
    delete noPort["local_port"];
    expect(() => parseTunnel(noPort)).toThrow(ConfigError);
    const noRemote = { ...reverse };
    delete noRemote["remote_port"];
    expect(() => parseTunnel(noRemote)).toThrow(ConfigError);
  });

  it("accepts every transport on tcp, udp and https tunnels, with a peer override", () => {
    const https = { ...base, name: "grafana", kind: "https", target: "127.0.0.1:3000", hostname: "grafana.prod-1.reoclo.localhost" };
    for (const via of ["reoclo", "tailscale", "auto"]) {
      expect(parseTunnel({ ...forward, via })).toMatchObject({ via });
      expect(parseTunnel({ ...forward, kind: "udp", via })).toMatchObject({ via });
      expect(parseTunnel({ ...https, via })).toMatchObject({ via });
    }
    expect(parseTunnel({ ...forward, via: "auto", tailnet_host: "db-box", server_hostname: "prod-1.internal" })).toMatchObject({
      tailnet_host: "db-box",
      server_hostname: "prod-1.internal",
    });
    expect(messageOf(captured(() => parseTunnel({ ...forward, via: "carrier-pigeon" })))).toContain("via");
  });

  it("keeps a reverse tunnel on the relay", () => {
    expect(parseTunnel({ ...reverse, via: "reoclo" })).toMatchObject({ via: "reoclo" });
    expect(() => parseTunnel({ ...reverse, via: "tailscale" })).toThrow(ConfigError);
    expect(() => parseTunnel({ ...reverse, via: "auto" })).toThrow(ConfigError);
    expect(() => parseTunnel({ ...reverse, tailnet_host: "box" })).toThrow(ConfigError);
    expect(() => parseTunnel({ ...reverse, share: { tailnet: true, port: 8080 } })).toThrow(ConfigError);
  });

  it("refuses keep_up with via: tailscale, because keep_up holds a gateway session", () => {
    expect(() => parseTunnel({ ...forward, via: "tailscale", keep_up: true })).toThrow(/keep_up/);
    expect(parseTunnel({ ...forward, via: "auto", keep_up: true })).toMatchObject({ keep_up: true });
  });

  it("validates shares: tcp needs no internal port, https needs one, udp cannot be shared", () => {
    const https = { ...base, name: "grafana", kind: "https", target: "127.0.0.1:3000", hostname: "grafana.prod-1.reoclo.localhost" };
    expect(parseTunnel({ ...forward, share: { tailnet: true, port: 5432 } })).toMatchObject({ share: { tailnet: true, port: 5432 } });
    expect(() => parseTunnel({ ...forward, share: { tailnet: true, port: 5432, internal_port: 9 } })).toThrow(/internal_port/);
    expect(parseTunnel({ ...https, share: { tailnet: true, port: 443, internal_port: 18443 } })).toMatchObject({ share: { internal_port: 18443 } });
    expect(() => parseTunnel({ ...https, share: { tailnet: true, port: 443 } })).toThrow(/internal_port/);
    expect(() => parseTunnel({ ...forward, kind: "udp", share: { tailnet: true, port: 5432 } })).toThrow(/tcp and https/);
    expect(() => parseTunnel({ ...forward, share: { tailnet: false, port: 5432 } })).toThrow(ConfigError);
    expect(() => parseTunnel({ ...forward, share: { tailnet: true } })).toThrow(ConfigError);
  });

  it("rejects two shares on one port and an internal port that is another tunnel's local port", () => {
    const a = parseTunnel({ ...forward, name: "a", local_port: 15001, share: { tailnet: true, port: 5432 } });
    const b = parseTunnel({ ...forward, name: "b", local_port: 15002, share: { tailnet: true, port: 5432 } });
    expect(() => parseConfig({ version: 1, tunnels: [a, b] })).toThrow(/share port 5432 is already used by tunnel "a"/);
    const https = parseTunnel({
      ...base,
      name: "web",
      kind: "https",
      target: "127.0.0.1:3000",
      hostname: "web.prod-1.reoclo.localhost",
      share: { tailnet: true, port: 443, internal_port: 15001 },
    });
    expect(() => parseConfig({ version: 1, tunnels: [a, https] })).toThrow(/internal_port 15001 is already used as the local_port of tunnel "a"/);
  });

  it("accepts an https tunnel with a hostname and no local port", () => {
    const https = { ...base, name: "grafana", kind: "https", target: "127.0.0.1:3000", hostname: "grafana.prod-1.reoclo.localhost" };
    expect<unknown>(parseTunnel(https)).toEqual({ ...https, keep_up: false, enabled: true });
    expect(() => parseTunnel({ ...https, local_port: 15000 })).toThrow(ConfigError);
    const noHost: Record<string, unknown> = { ...https };
    delete noHost["hostname"];
    expect(() => parseTunnel(noHost)).toThrow(ConfigError);
    expect(() => parseTunnel({ ...https, hostname: "Grafana.Local" })).toThrow(/lowercase DNS name/);
  });

  it("allows a hostname on a tcp tunnel and not on a reverse tunnel", () => {
    expect(parseTunnel({ ...forward, hostname: "db.prod-1.reoclo.localhost" })).toMatchObject({ hostname: "db.prod-1.reoclo.localhost" });
    expect(() => parseTunnel({ ...reverse, hostname: "hook.reoclo.localhost" })).toThrow(ConfigError);
  });

  it("accepts via: reoclo and rejects unknown fields", () => {
    expect(parseTunnel({ ...forward, via: "reoclo" }).name).toBe("prod-db");
    expect(() => parseTunnel({ ...forward, surprise: 1 })).toThrow(ConfigError);
  });
});

describe("parseConfig", () => {
  it("fills defaults for an empty file body", () => {
    expect(parseConfig({ version: 1 })).toEqual(emptyConfig());
  });

  it("rejects another version", () => {
    expect(() => parseConfig({ version: 2, tunnels: [] })).toThrow(ConfigError);
  });

  it("rejects duplicate names and duplicate forward local ports", () => {
    expect(() => parseConfig({ version: 1, tunnels: [forward, forward] })).toThrow(/duplicate tunnel name/);
    expect(() =>
      parseConfig({ version: 1, tunnels: [forward, { ...forward, name: "other" }] }),
    ).toThrow(/local_port 15432 is already used by tunnel "prod-db"/);
  });

  it("lets a reverse tunnel reuse a number a forward tunnel uses as its local port", () => {
    const cfg = parseConfig({ version: 1, tunnels: [forward, { ...reverse, remote_port: 15432 }] });
    expect(cfg.tunnels).toHaveLength(2);
  });

  it("defaults the HTTPS port to 8443 and the suffix and host lists to empty", () => {
    expect(parseConfig({ version: 1 })).toMatchObject({ https_port: 8443, ca_suffixes: [], manual_hosts: [] });
    expect(parseConfig({ version: 1, https_port: 9443 }).https_port).toBe(9443);
    expect(() => parseConfig({ version: 1, https_port: 70000 })).toThrow(ConfigError);
  });

  const https = (name: string, hostname: string): Record<string, unknown> => ({ ...base, name, kind: "https", target: "127.0.0.1:3000", hostname });

  it("requires a hostname to end in reoclo.localhost or an allowed suffix", () => {
    expect(() => parseConfig({ version: 1, tunnels: [https("a", "a.example.com")] })).toThrow(/must end in reoclo.localhost/);
    expect(() => parseConfig({ version: 1, tunnels: [https("a", "a.other.localhost")] })).toThrow(/must end in reoclo.localhost/);
    expect(parseConfig({ version: 1, tunnels: [https("a", "reoclo.localhost")] }).tunnels).toHaveLength(1);
    const withSuffix = parseConfig({ version: 1, ca_suffixes: ["internal"], tunnels: [https("a", "grafana.internal")] });
    expect(withSuffix.tunnels).toHaveLength(1);
  });

  it("rejects a hostname used twice, across kinds and against manual hosts", () => {
    const dup = [https("a", "x.reoclo.localhost"), { ...forward, hostname: "x.reoclo.localhost" }];
    expect(() => parseConfig({ version: 1, tunnels: dup })).toThrow(/already used by tunnel "a"/);
    expect(() =>
      parseConfig({ version: 1, manual_hosts: ["x.reoclo.localhost"], tunnels: [https("a", "x.reoclo.localhost")] }),
    ).toThrow(/already used by a manual host/);
  });

  it("validates manual hosts and allows any .localhost name there", () => {
    expect(parseConfig({ version: 1, manual_hosts: ["app.localhost", "x.reoclo.localhost"] }).manual_hosts).toHaveLength(2);
    expect(() => parseConfig({ version: 1, manual_hosts: ["github.com"] })).toThrow(/must end in/);
    expect(() => parseConfig({ version: 1, manual_hosts: ["Not A Host"] })).toThrow(/not a valid hostname/);
    const many = Array.from({ length: 513 }, (_, i) => `h${i}.reoclo.localhost`);
    expect(() => parseConfig({ version: 1, manual_hosts: many })).toThrow(/at most 512/);
  });

  it("rejects a CA suffix that could be a public top-level domain", () => {
    expect(parseConfig({ version: 1, ca_suffixes: ["internal", "corp.example.com"] }).ca_suffixes).toHaveLength(2);
    expect(() => parseConfig({ version: 1, ca_suffixes: ["com"] })).toThrow(/single label/);
  });
});

describe("loadConfig and saveConfig", () => {
  it("treats a missing file as empty", () => {
    expect(loadConfig(file)).toEqual(emptyConfig());
  });

  it("round-trips through YAML", () => {
    const cfg = parseConfig({
      version: 1,
      idle_timeout_seconds: 30,
      https_port: 9443,
      ca_suffixes: ["internal"],
      manual_hosts: ["app.internal"],
      tunnels: [forward, reverse, { ...base, name: "web", kind: "https", target: "127.0.0.1:80", hostname: "web.internal" }],
    });
    saveConfig(cfg, file);
    expect(loadConfig(file)).toEqual(cfg);
    expect(readFileSync(file, "utf8")).toContain("name: prod-db");
  });

  it("writes atomically and leaves no temp file", () => {
    saveConfig(emptyConfig(), file);
    expect(readdirSync(join(dir, "tunnels"))).toEqual(["tunnels.yaml"]);
  });

  it("names the file when it is invalid", () => {
    saveConfig(emptyConfig(), file);
    writeFileSync(file, "version: 1\ntunnels:\n  - name: BAD\n");
    expect(() => loadConfig(file)).toThrow(/tunnels\.yaml/);
    writeFileSync(file, "version: [");
    expect(() => loadConfig(file)).toThrow(/not valid YAML/);
  });

  it("refuses to save an invalid config", () => {
    const bad = { ...emptyConfig(), version: 1 as const, tunnels: [{ ...forward, name: "BAD" }] };
    expect(() => saveConfig(bad as never, file)).toThrow(ConfigError);
    expect(existsSync(file)).toBe(false);
  });
});

describe("updateConfig", () => {
  it("applies changes under the lock and saves them", async () => {
    await updateConfig((f) => {
      f.tunnels.push(parseTunnel(forward));
    }, file);
    await updateConfig((f) => {
      f.tunnels.push(parseTunnel(reverse));
    }, file);
    expect(loadConfig(file).tunnels.map((t) => t.name)).toEqual(["prod-db", "hook"]);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("does not save when the change throws", async () => {
    expect(messageOf(await rejectionOf(
      updateConfig(() => {
        throw new Error("nope");
      }, file),
    ))).toContain("nope");
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });
});
