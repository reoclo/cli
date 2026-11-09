// tests/integration/tunnel-local-cli.test.ts
//
// `reoclo tunnel add --kind local` against an in-process daemon, with no
// credentials at all: the config dir is empty, so any sign-in or org lookup
// would fail the command. Temp config dir, fake hosts helper, free HTTPS port.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCa, LeafIssuer } from "../../src/tunnels/ca";
import { emptyConfig, saveConfig } from "../../src/tunnels/config";
import { ControlClient } from "../../src/tunnels/control-client";
import { startDaemon, type DaemonHandle } from "../../src/tunnels/daemon";
import type { HelperStatus, HostsSink } from "../../src/tunnels/hosts-client";
import { caDir, tunnelsFile } from "../../src/tunnels/paths";
import { freePort } from "../helpers/fake-ws-gateway";

class FakeHosts implements HostsSink {
  sets: string[][] = [];
  private status0(): HelperStatus {
    return { version: "fake", entries: this.sets.at(-1)?.length ?? 0, suffixes: [], relay: { enabled: false, listening: false } };
  }
  status(): Promise<HelperStatus> {
    return Promise.resolve(this.status0());
  }
  set(entries: readonly string[]): Promise<HelperStatus> {
    this.sets.push([...entries]);
    return Promise.resolve(this.status0());
  }
}

let tmp: string;
let daemon: DaemonHandle | undefined;
let hosts: FakeHosts;
let saved: Record<string, string | undefined>;

function setEnv(key: string, value: string): void {
  if (!(key in saved)) saved[key] = process.env[key];
  process.env[key] = value;
}

beforeEach(async () => {
  saved = {};
  tmp = mkdtempSync(join(tmpdir(), "rt-local-cli-"));
  setEnv("REOCLO_CONFIG_DIR", tmp);
  setEnv("REOCLO_CACHE_DIR", join(tmp, "cache"));
  saveConfig({ ...emptyConfig(), https_port: await freePort(), ca_suffixes: ["reoclo.test"] }, tunnelsFile());
  await createCa(["reoclo.test"], { dir: caDir() });
  hosts = new FakeHosts();
  daemon = await startDaemon({ log: () => undefined, certs: new LeafIssuer(), hosts });
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", "src/index.ts", "tunnel", ...args], {
      cwd: join(import.meta.dir, "../.."),
      env: { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("reoclo tunnel add --kind local", () => {
  it("saves a route with no sign-in, server or org, and lists it", async () => {
    const add = await cli(["add", "app", "--kind", "local", "--hostname", "app.reoclo.test", "--local-target", "48080"]);
    expect(add.stderr).toBe("");
    expect(add.code).toBe(0);
    expect(add.stdout).toContain("tunnel: app (local)");
    const client = new ControlClient(daemon!.socketPath);
    expect(await client.tunnel("app")).toMatchObject({
      kind: "local",
      org: "",
      server: "",
      server_id: "",
      hostname: "app.reoclo.test",
      local_target: "127.0.0.1:48080",
      state: "active",
    });
    expect(hosts.sets.at(-1)).toContain("app.reoclo.test");
    const status = await cli(["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("app.reoclo.test");
    expect(status.stdout).toContain("127.0.0.1:48080");
  }, 30_000);

  it("rejects --server for a local route and saves nothing", async () => {
    const withServer = await cli(["add", "app", "--kind", "local", "--hostname", "app.reoclo.test", "--local-target", "48080", "--server", "prod-1"]);
    expect(withServer.code).toBe(2);
    expect(withServer.stderr).toContain("--server does not apply to a local tunnel");
    const client = new ControlClient(daemon!.socketPath);
    expect(await client.tunnels()).toEqual([]);
  }, 30_000);
});
