import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import dgram from "node:dgram";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../../src/tunnels/config";
import { TunnelManager, type PoolKey } from "../../../src/tunnels/manager";
import type { ScannedPort } from "../../../src/tunnels/tailscale";
import { FakePool, ManualTimers } from "../../helpers/fake-pool";
import {
  Changes,
  FakeSpawner,
  FakeTailscaleRunner,
  STOPPED_STATUS,
  fakeTailscale,
  fireDelay,
  statusJson,
} from "../../helpers/fake-tailscale";
import { freePort } from "../../helpers/fake-ws-gateway";
import { messageOf, rejectionOf } from "../../helpers/rejection";

let dir: string;
let configPath: string;
let managers: TunnelManager[];
let pools: Map<string, FakePool>;
let keys: PoolKey[];
let timers: ManualTimers;
let runner: FakeTailscaleRunner;
let spawner: FakeSpawner;
let changes: Changes;
let scan: ScannedPort[] | undefined | Error;
let scanCalls: number;
let logs: string[];
let cleanup: Array<() => Promise<void>>;

function newManager(): TunnelManager {
  const m = new TunnelManager({
    configPath,
    timers,
    tailscale: fakeTailscale(runner),
    spawnShare: spawner.spawn,
    log: (l) => logs.push(l),
    portScan: () => {
      scanCalls++;
      return scan instanceof Error ? Promise.reject(scan) : Promise.resolve(scan);
    },
    createPool: (key) => {
      keys.push(key);
      const pool = pools.get(key.server_id) ?? new FakePool();
      pools.set(key.server_id, pool);
      return pool;
    },
  });
  m.onEvent(() => changes.notify());
  managers.push(m);
  return m;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reoclo-mgr-ts-"));
  configPath = join(dir, "tunnels.yaml");
  managers = [];
  pools = new Map();
  keys = [];
  timers = new ManualTimers();
  runner = new FakeTailscaleRunner();
  runner.status = statusJson({ peers: [{ host: "prod-1", ips: ["127.0.0.1"] }] });
  spawner = new FakeSpawner();
  changes = new Changes();
  scan = undefined;
  scanCalls = 0;
  logs = [];
  cleanup = [];
});
afterEach(async () => {
  for (const m of managers) await m.stop();
  for (const fn of cleanup) await fn();
  rmSync(dir, { recursive: true, force: true });
});

const base = { org: "acme", tenant_id: "t1", server: "prod-1", server_id: "s1", server_hostname: "prod-1" };

/** A TCP service on 127.0.0.1 that echoes, standing in for the server's port on the tailnet. */
async function echoService(): Promise<number> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on("error", () => undefined);
    s.once("close", () => sockets.delete(s));
    s.pipe(s);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  );
  return (server.address() as net.AddressInfo).port;
}

async function tcp(name: string, target: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return { ...base, name, kind: "tcp", target, local_port: await freePort(), ...extra };
}

function exchange(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    let got = "";
    s.once("error", reject);
    s.once("connect", () => s.write(payload));
    s.on("data", (b) => {
      got += b.toString();
      if (got.length >= payload.length) {
        s.destroy();
        resolve(got);
      }
    });
    s.once("close", () => resolve(got));
  });
}

/** True when the connection is closed by the daemon without any data. */
function refused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    let data = false;
    s.on("error", () => undefined);
    s.on("data", () => (data = true));
    s.once("close", () => resolve(!data));
    s.once("connect", () => s.write("ping"));
  });
}

const pool = (): FakePool => pools.get("s1") as FakePool;

describe("via: tailscale", () => {
  it("pipes bytes to the peer's tailnet address with no session, no lease and no pool", async () => {
    const m = newManager();
    const peerPort = await echoService();
    const cfg = await tcp("db", `127.0.0.1:${peerPort}`, { via: "tailscale" });
    await m.add(cfg);
    await changes.until(() => m.get("db").peer !== undefined, "the peer to be matched");
    expect(m.get("db")).toMatchObject({ via: "tailscale", path: "tailscale", state: "ready", peer: { name: "prod-1", address: "127.0.0.1", online: true } });

    const s = net.connect(cfg["local_port"] as number, "127.0.0.1");
    await new Promise<void>((r) => s.once("connect", () => r()));
    s.write("hello");
    await new Promise<void>((r) => s.once("data", () => r()));
    expect(m.get("db").state).toBe("active");
    s.destroy();
    await changes.until(() => m.get("db").state === "ready", "the tunnel to be idle again");

    expect(keys).toHaveLength(0);
    expect(logs.some((l) => l.includes(`over the tailnet to 127.0.0.1:${peerPort}`))).toBe(true);
    expect(m.get("db").traffic.bytes_in).toBeGreaterThan(0);
  });

  it("echoes whole payloads in both directions", async () => {
    const m = newManager();
    const cfg = await tcp("db", `127.0.0.1:${await echoService()}`, { via: "tailscale" });
    await m.add(cfg);
    expect(await exchange(cfg["local_port"] as number, "x".repeat(50_000))).toHaveLength(50_000);
  });

  const refusals: Array<{ why: string; setup: () => void; target?: string; detail: string }> = [
    { why: "Tailscale is stopped", setup: () => (runner.status = STOPPED_STATUS), detail: "Tailscale is not running (Stopped)" },
    { why: "no peer has the server's name", setup: () => (runner.status = statusJson({ peers: [{ host: "elsewhere" }] })), detail: 'no tailnet peer is named "prod-1"' },
    { why: "the peer is offline", setup: () => (runner.status = statusJson({ peers: [{ host: "prod-1", ips: ["127.0.0.1"], online: false }] })), detail: "prod-1 is offline on the tailnet" },
    { why: "the peer has no IPv4 address", setup: () => (runner.status = statusJson({ peers: [{ host: "prod-1", ips: ["fd7a::1"] }] })), detail: "no IPv4 address" },
    { why: "the target is not loopback", setup: () => undefined, target: "db.internal:5432", detail: "not loopback" },
    {
      why: "the port listens only on loopback on the server",
      setup: () => (scan = [{ port: 5432, protocol: "tcp", bind_address: "127.0.0.1" }]),
      target: "127.0.0.1:5432",
      detail: "listens only on 127.0.0.1",
    },
  ];
  for (const r of refusals) {
    it(`refuses connections and says why when ${r.why}`, async () => {
      r.setup();
      const m = newManager();
      const cfg = await tcp("db", r.target ?? `127.0.0.1:${await echoService()}`, { via: "tailscale" });
      await m.add(cfg);
      await changes.until(() => m.get("db").state === "failed", "the tunnel to fail");
      expect(m.get("db").detail).toContain(r.detail);
      expect(await refused(cfg["local_port"] as number)).toBe(true);
      expect(keys).toHaveLength(0);
    });
  }

  it("recovers on its own path when Tailscale comes up and the tunnel is brought up again", async () => {
    runner.status = STOPPED_STATUS;
    const m = newManager();
    const cfg = await tcp("db", `127.0.0.1:${await echoService()}`, { via: "tailscale" });
    await m.add(cfg);
    await changes.until(() => m.get("db").state === "failed", "the tunnel to fail");
    runner.status = statusJson({ peers: [{ host: "prod-1", ips: ["127.0.0.1"] }] });
    await m.up("db");
    await changes.until(() => m.get("db").state === "ready", "the problem to clear");
    expect(await exchange(cfg["local_port"] as number, "ok")).toBe("ok");
  });

  it("says when the dial fails, and does not use the relay", async () => {
    const m = newManager();
    const cfg = await tcp("db", `127.0.0.1:${await freePort()}`, { via: "tailscale" });
    await m.add(cfg);
    expect(await refused(cfg["local_port"] as number)).toBe(true);
    await changes.until(() => m.get("db").state === "failed", "the tunnel to fail");
    expect(m.get("db").detail).toContain("could not dial 127.0.0.1");
    expect(keys).toHaveLength(0);
  });

  it("allows a port the scan lacks, a reachable bind, and a scan that fails", async () => {
    const scenarios: Array<(port: number) => ScannedPort[] | Error> = [
      () => [{ port: 1, protocol: "tcp", bind_address: "127.0.0.1" }],
      (port) => [{ port, protocol: "tcp", bind_address: "0.0.0.0" }],
      () => new Error("offline"),
    ];
    for (const [i, scenario] of scenarios.entries()) {
      const peerPort = await echoService();
      scan = scenario(peerPort);
      const m = newManager();
      const cfg = await tcp(`db-${i}`, `127.0.0.1:${peerPort}`, { via: "tailscale" });
      await m.add(cfg);
      expect(await exchange(cfg["local_port"] as number, "ok")).toBe("ok");
    }
  });

  it("reads the port scan once for connections within five minutes", async () => {
    const m = newManager();
    const cfg = await tcp("db", `127.0.0.1:${await echoService()}`, { via: "tailscale" });
    await m.add(cfg);
    await exchange(cfg["local_port"] as number, "a");
    await exchange(cfg["local_port"] as number, "b");
    expect(scanCalls).toBe(1);
  });

  it("matches tailnet_host before the server hostname", async () => {
    runner.status = statusJson({ peers: [{ host: "box-1", ips: ["127.0.0.1"] }] });
    const m = newManager();
    const cfg = await tcp("db", `127.0.0.1:${await echoService()}`, { via: "tailscale", server_hostname: "wrong-name", tailnet_host: "box-1" });
    await m.add(cfg);
    expect(await exchange(cfg["local_port"] as number, "hi")).toBe("hi");
  });

  it("matches the first label of the DNS name when the host name differs", async () => {
    runner.status = statusJson({ peers: [{ host: "Renamed-Laptop", dns: "prod-1", ips: ["127.0.0.1"] }] });
    const m = newManager();
    const cfg = await tcp("db", `localhost:${await echoService()}`, { via: "tailscale" });
    await m.add(cfg);
    expect(await exchange(cfg["local_port"] as number, "hi")).toBe("hi");
  });

  it("needs a hostname to look for when the tunnel was saved without one", async () => {
    const m = newManager();
    const cfg = await tcp("db", `127.0.0.1:${await echoService()}`, { via: "tailscale" });
    delete cfg["server_hostname"];
    await m.add(cfg);
    await changes.until(() => m.get("db").state === "failed", "the tunnel to fail");
    expect(m.get("db").detail).toContain("set tailnet_host");
  });
});

describe("via: auto", () => {
  it("uses the tailnet when the peer is online and the target is eligible, without taking a lease", async () => {
    const m = newManager();
    const cfg = await tcp("db", `127.0.0.1:${await echoService()}`, { via: "auto" });
    await m.add(cfg);
    expect(await exchange(cfg["local_port"] as number, "tail")).toBe("tail");
    expect(m.get("db").path).toBe("tailscale");
    expect(pool().acquired).toEqual([]);
  });

  const fallbacks: Array<{ why: string; setup: () => void; target?: string; reason: string }> = [
    { why: "the peer is offline", setup: () => (runner.status = statusJson({ peers: [{ host: "prod-1", online: false }] })), reason: "offline" },
    { why: "Tailscale is stopped", setup: () => (runner.status = STOPPED_STATUS), reason: "not running" },
    { why: "the target is not loopback", setup: () => undefined, target: "db.internal:5432", reason: "not loopback" },
    { why: "the port listens only on loopback", setup: () => (scan = [{ port: 5432, protocol: "tcp", bind_address: "::1" }]), target: "127.0.0.1:5432", reason: "listens only on" },
  ];
  for (const f of fallbacks) {
    it(`uses the relay when ${f.why}`, async () => {
      f.setup();
      const m = newManager();
      const cfg = await tcp("db", f.target ?? `127.0.0.1:${await echoService()}`, { via: "auto" });
      await m.add(cfg);
      const s = net.connect(cfg["local_port"] as number, "127.0.0.1");
      s.on("error", () => undefined);
      await pool().session.waitFor("attached", () => pool().session.attached.length === 1);
      s.destroy();
      expect(pool().acquired).toEqual(["stream"]);
      await changes.until(() => m.get("db").path_reason?.includes(f.reason) === true, `the path reason to say ${f.reason}`);
      expect(m.get("db")).toMatchObject({ path: "relay", via: "auto" });
    });
  }

  it("falls back to the relay once when the tailnet dial fails, and says why", async () => {
    const m = newManager();
    const port = await freePort();
    const cfg = await tcp("db", `127.0.0.1:${port}`, { via: "auto" });
    await m.add(cfg);
    const s = net.connect(cfg["local_port"] as number, "127.0.0.1");
    s.on("error", () => undefined);
    await pool().session.waitFor("attached", () => pool().session.attached.length === 1);
    s.destroy();
    expect(pool().session.attached[0]?.target).toEqual({ remoteHost: "127.0.0.1", remotePort: port });
    expect(m.get("db")).toMatchObject({ path: "relay" });
    expect(m.get("db").path_reason).toContain("the tailnet");
  });

  it("looks at the tailnet again for the next connection", async () => {
    runner.status = statusJson({ peers: [{ host: "prod-1", ips: ["127.0.0.1"], online: false }] });
    const m = newManager();
    const cfg = await tcp("db", `127.0.0.1:${await echoService()}`, { via: "auto" });
    await m.add(cfg);
    const s = net.connect(cfg["local_port"] as number, "127.0.0.1");
    s.on("error", () => undefined);
    await pool().session.waitFor("attached", () => pool().session.attached.length === 1);
    s.destroy();
    runner.status = statusJson({ peers: [{ host: "prod-1", ips: ["127.0.0.1"], online: true }] });
    expect(await exchange(cfg["local_port"] as number, "back")).toBe("back");
    expect(pool().session.attached).toHaveLength(1);
    expect(m.get("db").path).toBe("tailscale");
  });
});

describe("via: reoclo", () => {
  it("never asks Tailscale, and reports the relay path", async () => {
    const m = newManager();
    const cfg = await tcp("db", "127.0.0.1:5432");
    await m.add(cfg);
    const s = net.connect(cfg["local_port"] as number, "127.0.0.1");
    s.on("error", () => undefined);
    await pool().session.waitFor("attached", () => pool().session.attached.length === 1);
    s.destroy();
    expect(runner.calls).toEqual([]);
    expect(m.get("db")).toMatchObject({ via: "reoclo", path: "relay" });
    expect(m.get("db").peer).toBeUndefined();
  });

  it("reports the tailscale status for the daemon status", async () => {
    runner.status = STOPPED_STATUS;
    expect(await newManager().tailscaleStatus()).toEqual({ installed: true, running: false, state: "Stopped", tailnet: "example-tailnet.ts.net", https_certificates: false });
  });
});

describe("UDP over the tailnet", () => {
  async function udpEcho(): Promise<{ port: number; sources: number[] }> {
    const sock = dgram.createSocket("udp4");
    const sources: number[] = [];
    sock.on("message", (msg, rinfo) => {
      sources.push(rinfo.port);
      sock.send(msg, rinfo.port, rinfo.address);
    });
    await new Promise<void>((r) => sock.bind(0, "127.0.0.1", () => r()));
    cleanup.push(() => new Promise<void>((r) => sock.close(() => r())));
    return { port: sock.address().port, sources };
  }

  function client(): { send: (to: number, text: string) => Promise<string>; port: () => number; close: () => void } {
    const sock = dgram.createSocket("udp4");
    sock.bind(0, "127.0.0.1");
    cleanup.push(() => new Promise<void>((r) => sock.close(() => r())));
    return {
      send: (to, text) =>
        new Promise((resolve) => {
          sock.once("message", (b) => resolve(b.toString()));
          sock.send(text, to, "127.0.0.1");
        }),
      port: () => sock.address().port,
      close: () => sock.close(),
    };
  }

  const udp = async (name: string, peerPort: number, via: string): Promise<{ [k: string]: unknown }> => ({ ...base, name, kind: "udp", target: `127.0.0.1:${peerPort}`, local_port: await freePort(), via });

  it("keeps one socket per local peer and closes it after 60 idle seconds", async () => {
    const m = newManager();
    const peer = await udpEcho();
    const cfg = await udp("dns", peer.port, "tailscale");
    await m.add(cfg);
    const local = cfg["local_port"] as number;
    const a = client();
    const b = client();
    expect(await a.send(local, "one")).toBe("one");
    expect(await a.send(local, "two")).toBe("two");
    expect(await b.send(local, "three")).toBe("three");
    expect(peer.sources[0]).toBe(peer.sources[1]);
    expect(peer.sources[2]).not.toBe(peer.sources[0]);
    expect(m.get("dns").state).toBe("active");
    expect(keys).toHaveLength(0);

    expect(fireDelay(timers, 60_000)).toBe(2);
    await changes.until(() => m.get("dns").state === "ready", "the idle sockets to close");
    expect(await a.send(local, "again")).toBe("again");
    expect(m.get("dns").state).toBe("active");
  });

  it("sends through the relay when auto finds the peer offline", async () => {
    runner.status = statusJson({ peers: [{ host: "prod-1", online: false }] });
    const m = newManager();
    const peer = await udpEcho();
    const cfg = await udp("dns", peer.port, "auto");
    await m.add(cfg);
    pool().setState({ state: "active" });
    const a = client();
    a.send(cfg["local_port"] as number, "relay-me").catch(() => undefined);
    await pool().session.waitFor("datagram", () => pool().session.datagrams.length === 1);
    expect(pool().session.datagrams[0]?.buf.toString()).toBe("relay-me");
    expect(peer.sources).toEqual([]);
  });
});

describe("sharing a tunnel", () => {
  const shareProc = (n: number): Promise<void> => changes.until(() => spawner.procs.length >= n, `share child ${n}`);

  it("runs a foreground tailscale serve for a tcp tunnel, saves the share, and shows its state", async () => {
    const m = newManager();
    const cfg = await tcp("db", "127.0.0.1:5432");
    await m.add(cfg);
    const view = await m.share("db", { tailnet: true });
    expect(view.share).toMatchObject({ tailnet: true, port: 5432, state: "starting" });
    await shareProc(1);
    expect(spawner.procs[0]?.args).toEqual(["serve", "--tcp=5432", `tcp://127.0.0.1:${String(cfg["local_port"])}`]);
    expect(loadConfig(configPath).tunnels[0]).toMatchObject({ share: { tailnet: true, port: 5432 } });

    spawner.procs[0]?.say("Available within your tailnet:\n");
    await changes.until(() => m.get("db").share?.state === "active", "the share to be active");
    expect(m.get("db").share?.url).toBe("tcp://laptop.example-tailnet.ts.net:5432");
  });

  it("takes the port from the request, and keeps it when shared again without one", async () => {
    const m = newManager();
    await m.add(await tcp("db", "127.0.0.1:5432"));
    await m.share("db", { tailnet: true, port: 6000 });
    await shareProc(1);
    expect(spawner.procs[0]?.args[1]).toBe("--tcp=6000");
    await m.share("db", { tailnet: true });
    await shareProc(2);
    expect(spawner.procs[1]?.args[1]).toBe("--tcp=6000");
  });

  it("ends the share with the tunnel: down, remove and daemon stop", async () => {
    const m = newManager();
    await m.add(await tcp("db", "127.0.0.1:5432"));
    await m.share("db", { tailnet: true });
    await shareProc(1);

    await m.down("db");
    expect(spawner.procs[0]?.killed).toEqual(["SIGTERM"]);
    expect(m.get("db").share?.state).toBe("down");
    expect(loadConfig(configPath).tunnels[0]).toMatchObject({ share: { port: 5432 } });

    await m.up("db");
    await shareProc(2);
    await m.remove("db");
    expect(spawner.procs[1]?.killed).toEqual(["SIGTERM"]);

    await m.add(await tcp("db2", "127.0.0.1:5433", { share: { tailnet: true } }));
    await shareProc(3);
    await m.stop();
    expect(spawner.procs[2]?.killed).toEqual(["SIGTERM"]);
  });

  it("restores a saved share when the manager starts, and unshare stops it and removes it from the file", async () => {
    const first = newManager();
    await first.add(await tcp("db", "127.0.0.1:5432", { share: { tailnet: true } }));
    await shareProc(1);
    await first.stop();
    const second = newManager();
    await second.start();
    await shareProc(2);
    expect(spawner.procs[1]?.args[1]).toBe("--tcp=5432");

    const view = await second.unshare("db");
    expect(view.share).toBeUndefined();
    expect(spawner.procs[1]?.killed).toEqual(["SIGTERM"]);
    expect(loadConfig(configPath).tunnels[0]).not.toHaveProperty("share");
    expect((await second.unshare("db")).share).toBeUndefined();
    expect(spawner.procs).toHaveLength(2);
  });

  it("reports why a share is not up without failing the tunnel", async () => {
    runner.status = STOPPED_STATUS;
    const m = newManager();
    await m.add(await tcp("db", "127.0.0.1:5432"));
    await m.share("db", { tailnet: true });
    await changes.until(() => m.get("db").share?.state === "failed", "the share to fail");
    expect(m.get("db").share?.error).toContain("not running (Stopped)");
    expect(m.get("db").state).toBe("ready");
    runner.status = statusJson();
    expect(fireDelay(timers, 1000)).toBe(1);
    await shareProc(1);
  });

  it("rejects what cannot be shared", async () => {
    const m = newManager();
    await m.add(await tcp("db", "127.0.0.1:5432"));
    await m.add(await tcp("dns", "127.0.0.1:53", { kind: "udp" }));
    await m.add({ org: "acme", tenant_id: "t1", server: "prod-1", server_id: "s1", name: "hook", kind: "reverse", remote_port: 8080, local_target: "127.0.0.1:3000" });
    expect(messageOf(await rejectionOf(m.share("db", {})))).toContain("tailnet: true is required");
    expect(messageOf(await rejectionOf(m.share("db", { tailnet: true, port: "x" })))).toContain("port must be a number");
    expect(messageOf(await rejectionOf(m.share("dns", { tailnet: true })))).toContain("only tcp and https");
    expect(messageOf(await rejectionOf(m.share("hook", { tailnet: true })))).toContain("only tcp and https");
    expect(await rejectionOf(m.share("ghost", { tailnet: true }))).toMatchObject({ code: "not_found" });
    expect(spawner.procs).toHaveLength(0);
  });

  it("refuses a second share on a port another tunnel already shares", async () => {
    const m = newManager();
    await m.add(await tcp("a", "127.0.0.1:5432", { share: { tailnet: true } }));
    await m.add(await tcp("b", "127.0.0.1:5433"));
    expect(messageOf(await rejectionOf(m.share("b", { tailnet: true, port: 5432 })))).toContain('share port 5432 is already used by tunnel "a"');
  });

  it("shows no share on a tunnel that has none", async () => {
    const m = newManager();
    await m.add(await tcp("db", "127.0.0.1:5432"));
    expect(m.get("db").share).toBeUndefined();
  });
});
