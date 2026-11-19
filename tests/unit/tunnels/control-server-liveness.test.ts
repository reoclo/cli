// tests/unit/tunnels/control-server-liveness.test.ts
//
// What tells a live daemon from a dead one: ping and status answer while a
// probe is slow, any answer on the socket counts as alive, and a stopping
// server leaves alone a socket another daemon put at its path.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient, daemonResponding } from "../../../src/tunnels/control-client";
import { startControlServer, type ControlServer } from "../../../src/tunnels/control-server";
import { TunnelManager, type HostsStatusView } from "../../../src/tunnels/manager";
import { FakePool } from "../../helpers/fake-pool";

let dir: string;
let socket: string;
let manager: TunnelManager;
let server: ControlServer | undefined;

const helperUp: HostsStatusView = { installed: true, entries: 0, suffixes: [], relay: { enabled: false, listening: false } };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-live-"));
  socket = join(dir, "run", "tunneld.sock");
  manager = new TunnelManager({ configPath: join(dir, "tunnels.yaml"), createPool: () => new FakePool() });
  server = startControlServer({
    socketPath: socket,
    manager,
    version: "9.9.9",
    startedAt: Date.now(),
    stateDir: dir,
    log: () => undefined,
    onShutdown: () => undefined,
    statusProbeWaitMs: 50,
  });
});
afterEach(async () => {
  await server?.stop();
  await manager.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("daemon liveness", () => {
  it("answers ping with the pid and version", async () => {
    const ping = await new ControlClient(socket).request<{ pid: number; version: string }>("GET", "/v1/ping");
    expect(ping).toEqual({ pid: process.pid, version: "9.9.9" });
    expect(await daemonResponding(socket)).toBe(true);
  });

  it("answers status while a probe hangs, with that probe's last value", async () => {
    const client = new ControlClient(socket);
    let answer: Promise<HostsStatusView> = new Promise(() => undefined);
    manager.hostsStatus = () => answer;

    const first = await client.status();
    expect(first.pid).toBe(process.pid);
    expect(first.hosts).toBeUndefined();

    answer = Promise.resolve(helperUp);
    expect((await client.status()).hosts).toEqual(helperUp);

    answer = new Promise(() => undefined);
    expect((await client.status()).hosts).toEqual(helperUp);
  });

  it("counts any answer on the socket as a running daemon, including a 404 from an older one", async () => {
    const old = join(dir, "old.sock");
    const legacy = Bun.serve({ unix: old, fetch: () => new Response("{}", { status: 404 }) });
    expect(await daemonResponding(old)).toBe(true);
    await legacy.stop(true);
    expect(await daemonResponding(old)).toBe(false);
  });

  it("removes its own socket when it stops", async () => {
    await server?.stop();
    server = undefined;
    expect(existsSync(socket)).toBe(false);
  });

  it("leaves the socket of a daemon that took over the path", async () => {
    rmSync(socket);
    const successor = net.createServer();
    await new Promise<void>((r) => successor.listen(socket, () => r()));
    try {
      await server?.stop();
      server = undefined;
      expect(existsSync(socket)).toBe(true);
    } finally {
      await new Promise<void>((r) => successor.close(() => r()));
    }
  });
});
