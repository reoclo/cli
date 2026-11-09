// tests/integration/tunnel-daemon.test.ts
//
// The tunnel daemon against a local fake gateway WebSocket server: two saved
// tunnels to one server share one session, an idle session closes and reopens,
// 4408 and 4407 leave the tunnels down until `up`, and a restart restores the
// tunnels that were up. The daemon runs in this process with a temp config dir;
// it signs in through bootstrap() with a seeded profile, like the real thing.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../../src/tunnels/control-client";
import { saveConfig, emptyConfig } from "../../src/tunnels/config";
import { startDaemon, type DaemonHandle } from "../../src/tunnels/daemon";
import type { TunnelState } from "../../src/tunnels/states";
import { freePort, startFakeWsGateway, type FakeWsGateway } from "../helpers/fake-ws-gateway";
import { seedTenantProfile } from "../helpers/seed-profile";

const TENANT_ID = "00000000-0000-0000-0000-00000000aaaa";
const SERVER_ID = "00000000-0000-0000-0000-00000000bbbb";

let tmp: string;
let gw: FakeWsGateway;
let daemon: DaemonHandle | undefined;
let saved: Record<string, string | undefined>;

function setEnv(key: string, value: string): void {
  if (!(key in saved)) saved[key] = process.env[key];
  process.env[key] = value;
}

beforeEach(async () => {
  saved = {};
  tmp = mkdtempSync(join(tmpdir(), "rt-d-"));
  setEnv("REOCLO_CONFIG_DIR", tmp);
  setEnv("REOCLO_CACHE_DIR", join(tmp, "cache"));
  seedTenantProfile({ configDir: tmp, apiUrl: "http://127.0.0.1:1", token: "rk_t_daemon", tenantId: TENANT_ID });
  saveConfig({ ...emptyConfig(), idle_timeout_seconds: 0.3 }, join(tmp, "tunnels", "tunnels.yaml"));
  gw = await startFakeWsGateway({ echo: true });
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await gw.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

async function boot(): Promise<ControlClient> {
  daemon = await startDaemon({ directUrl: gw.url, log: () => undefined });
  return new ControlClient(daemon.socketPath);
}

async function addTunnel(client: ControlClient, name: string, target: string): Promise<number> {
  const local_port = await freePort();
  await client.add({
    name,
    org: "acme",
    tenant_id: TENANT_ID,
    profile: "default",
    server: "prod-1",
    server_id: SERVER_ID,
    kind: "tcp",
    target,
    local_port,
  });
  return local_port;
}

/** Resolve once every named tunnel is in `state`. Subscribes first, then checks, so no event is missed. */
function waitForState(names: string[], state: TunnelState, timeoutMs = 5000): Promise<void> {
  const manager = daemon!.manager;
  return new Promise((resolve, reject) => {
    const ok = (): boolean => names.every((n) => manager.get(n).state === state);
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for ${names.join(",")} to be ${state}; now ${names.map((n) => manager.get(n).state).join(",")}`));
    }, timeoutMs);
    const off = manager.onEvent(() => {
      if (!ok()) return;
      clearTimeout(timer);
      off();
      resolve();
    });
    if (ok()) {
      clearTimeout(timer);
      off();
      resolve();
    }
  });
}

/** Connect, send a line, and wait for the gateway's echo. Resolves with the open socket. */
async function roundTrip(port: number, text: string): Promise<net.Socket> {
  const sock = net.connect(port, "127.0.0.1");
  const echoed = new Promise<string>((resolve, reject) => {
    sock.once("data", (b) => resolve(b.toString()));
    sock.once("error", reject);
    sock.once("close", () => reject(new Error("socket closed before the echo")));
  });
  sock.write(text);
  expect(await echoed).toBe(text);
  return sock;
}

function closedSocket(sock: net.Socket): Promise<void> {
  return new Promise((resolve) => (sock.destroyed ? resolve() : sock.once("close", () => resolve())));
}

describe("tunnel daemon with a fake gateway", () => {
  it("carries two saved tunnels to one server over one session", async () => {
    const client = await boot();
    const db = await addTunnel(client, "prod-db", "127.0.0.1:5432");
    const cache = await addTunnel(client, "prod-cache", "127.0.0.1:6379");
    expect((await client.tunnels()).map((t) => t.state)).toEqual(["ready", "ready"]);

    const a = await roundTrip(db, "to-db");
    const b = await roundTrip(cache, "to-cache");

    expect(gw.connections).toBe(1);
    expect(gw.urls[0]).toContain(`server_id=${SERVER_ID}`);
    const opens = gw.frames.filter((f) => f["type"] === "tunnel_open");
    expect(opens.map((f) => [f["host"], f["port"]])).toEqual([
      ["127.0.0.1", 5432],
      ["127.0.0.1", 6379],
    ]);
    await waitForState(["prod-db", "prod-cache"], "active");
    a.destroy();
    b.destroy();
  });

  it("closes the session when idle and reopens it on the next connection", async () => {
    const client = await boot();
    const db = await addTunnel(client, "prod-db", "127.0.0.1:5432");
    const first = await roundTrip(db, "one");
    first.destroy();
    await closedSocket(first);

    await gw.waitFor(() => gw.closed === 1, "the idle session to close");
    await waitForState(["prod-db"], "ready");
    expect(gw.connections).toBe(1);

    const second = await roundTrip(db, "two");
    expect(gw.connections).toBe(2);
    second.destroy();
  });

  it("leaves tunnels expired after 4408 until up, and never reopens on its own", async () => {
    const client = await boot();
    const db = await addTunnel(client, "prod-db", "127.0.0.1:5432");
    const cache = await addTunnel(client, "prod-cache", "127.0.0.1:6379");
    const live = await roundTrip(db, "x");

    gw.closeAll(4408, "maximum duration reached");
    await waitForState(["prod-db", "prod-cache"], "expired");
    await closedSocket(live);
    expect(daemon!.manager.get("prod-db").detail).toBe("maximum duration reached");

    // A new connection is refused and does not dial the gateway again.
    const refused = net.connect(cache, "127.0.0.1");
    refused.on("error", () => undefined);
    await closedSocket(refused);
    expect(gw.connections).toBe(1);
    expect((await client.tunnels()).map((t) => t.state)).toEqual(["expired", "expired"]);

    // up on one tunnel clears the whole server.
    await client.up("prod-db");
    await waitForState(["prod-db", "prod-cache"], "ready");
    const again = await roundTrip(cache, "y");
    expect(gw.connections).toBe(2);
    again.destroy();
  });

  it("leaves tunnels closed_by_operator after 4407 until up", async () => {
    const client = await boot();
    const db = await addTunnel(client, "prod-db", "127.0.0.1:5432");
    const live = await roundTrip(db, "x");
    gw.closeAll(4407, "closed by operator");
    await waitForState(["prod-db"], "closed_by_operator");
    await closedSocket(live);
    await client.up("prod-db");
    await waitForState(["prod-db"], "ready");
  });

  it("shows a failed gateway close as server_offline and retries on the next connection", async () => {
    const client = await boot();
    const db = await addTunnel(client, "prod-db", "127.0.0.1:5432");
    const live = await roundTrip(db, "x");
    gw.closeAll(4410, "runner gone");
    await waitForState(["prod-db"], "server_offline");
    await closedSocket(live);
    const again = await roundTrip(db, "back");
    expect(gw.connections).toBe(2);
    again.destroy();
  });

  it("restores the tunnels that were up after the daemon restarts", async () => {
    let client = await boot();
    const up = await addTunnel(client, "up", "127.0.0.1:5432");
    const parked = await addTunnel(client, "parked", "127.0.0.1:6379");
    await client.down("parked");
    await daemon!.stop();

    client = await boot();
    expect((await client.tunnels()).map((t) => [t.name, t.state])).toEqual([
      ["parked", "down"],
      ["up", "ready"],
    ]);
    const sock = await roundTrip(up, "after-restart");
    sock.destroy();
    const closedPort = net.connect(parked, "127.0.0.1");
    closedPort.on("error", () => undefined);
    await closedSocket(closedPort);
  });

  it("opens a keep-up tunnel's session without a local connection and reuses it for streams", async () => {
    const client = await boot();
    const local_port = await freePort();
    await client.add({
      name: "held",
      org: "acme",
      tenant_id: TENANT_ID,
      server: "prod-1",
      server_id: SERVER_ID,
      kind: "tcp",
      target: "127.0.0.1:5432",
      local_port,
      keep_up: true,
    });
    await waitForState(["held"], "active");
    expect(gw.connections).toBe(1);
    // Never idles while the hold exists (covered with injected timers in the pool tests).
    const sock = await roundTrip(local_port, "ping");
    expect(gw.connections).toBe(1);
    sock.destroy();
  });

  it("registers a reverse tunnel on the gateway and removes it on down", async () => {
    const client = await boot();
    await client.add({
      name: "hook",
      org: "acme",
      tenant_id: TENANT_ID,
      server: "prod-1",
      server_id: SERVER_ID,
      kind: "reverse",
      remote_port: 8080,
      local_target: "127.0.0.1:3000",
    });
    const open = await gw.waitForFrame((f) => f["type"] === "tunnel_listen_open");
    expect(open).toMatchObject({ port: 8080, bind: "127.0.0.1", proto: "tcp" });
    await waitForState(["hook"], "active");
    await client.down("hook");
    const close = await gw.waitForFrame((f) => f["type"] === "tunnel_listen_close");
    expect(close["listen_id"]).toBe(open["listen_id"]);
  });
});
