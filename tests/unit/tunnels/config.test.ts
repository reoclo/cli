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

  it("rejects later-phase fields and names the phase that adds them", () => {
    expect(() => parseTunnel({ ...forward, kind: "https" })).toThrow(/phase 2/);
    expect(() => parseTunnel({ ...forward, hostname: "db.reoclo.localhost" })).toThrow(/phase 2/);
    expect(() => parseTunnel({ ...forward, via: "tailscale" })).toThrow(/phase 5/);
    expect(() => parseTunnel({ ...forward, via: "auto" })).toThrow(/phase 5/);
    expect(() => parseTunnel({ ...forward, share: { tailnet: true, port: 5432 } })).toThrow(/phase 6/);
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
});

describe("loadConfig and saveConfig", () => {
  it("treats a missing file as empty", () => {
    expect(loadConfig(file)).toEqual(emptyConfig());
  });

  it("round-trips through YAML", () => {
    const cfg = parseConfig({ version: 1, idle_timeout_seconds: 30, tunnels: [forward, reverse] });
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
