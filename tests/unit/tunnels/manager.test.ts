import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import dgram from "node:dgram";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../../src/tunnels/config";
import {
  ManagerError,
  TunnelManager,
  pickLocalPort,
  type ManagerEvent,
  type PoolKey,
} from "../../../src/tunnels/manager";
import { PoolError } from "../../../src/tunnels/pool";
import { FakePool, ManualTimers } from "../../helpers/fake-pool";
import { freePort } from "../../helpers/fake-ws-gateway";
import { messageOf, rejectionOf } from "../../helpers/rejection";

let dir: string;
let configPath: string;
let managers: TunnelManager[];
let pools: Map<string, FakePool>;
let keys: PoolKey[];
let timers: ManualTimers;

function newManager(): TunnelManager {
  const m = new TunnelManager({
    configPath,
    timers,
    createPool: (key) => {
      keys.push(key);
      const id = key.server_id;
      const pool = pools.get(id) ?? new FakePool();
      pools.set(id, pool);
      return pool;
    },
  });
  managers.push(m);
  return m;
}

const base = { org: "acme", tenant_id: "t1", server: "prod-1", server_id: "s1" };
const forward = async (name: string, extra: Record<string, unknown> = {}) => ({
  ...base,
  name,
  kind: "tcp",
  target: "127.0.0.1:5432",
  local_port: await freePort(),
  ...extra,
});

function pool(id = "s1"): FakePool {
  return pools.get(id)!;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reoclo-mgr-"));
  configPath = join(dir, "tunnels.yaml");
  managers = [];
  pools = new Map();
  keys = [];
  timers = new ManualTimers();
});
afterEach(async () => {
  for (const m of managers) await m.stop();
  rmSync(dir, { recursive: true, force: true });
});

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

function closed(sock: net.Socket): Promise<void> {
  return new Promise((resolve) => (sock.destroyed ? resolve() : sock.once("close", () => resolve())));
}

describe("pickLocalPort", () => {
  it("never returns 0 when no preferred port is given", async () => {
    const port = await pickLocalPort(0);
    expect(port).toBeGreaterThan(0);
  });

  it("skips a preferred port another saved tunnel uses", async () => {
    const taken = await freePort();
    const port = await pickLocalPort(taken, new Set([taken]));
    expect(port).not.toBe(taken);
    expect(port).toBeGreaterThan(0);
  });
});

describe("forward TCP", () => {
  it("holds the socket until the session is ready, then attaches it and delivers the early bytes", async () => {
    const m = newManager();
    const cfg = await forward("prod-db");
    let open!: () => void;
    await m.add({ ...cfg });
    pool().gate = new Promise<void>((r) => (open = r));
    pool().session.echo = true;
    const client = await connect(cfg.local_port);
    client.write("early");
    await pool().waitFor("acquire", () => pool().acquired.length > 0);
    expect(pool().session.attached).toHaveLength(0);
    const echoed = new Promise<string>((resolve) => client.once("data", (b) => resolve(b.toString())));
    open();
    expect(await echoed).toBe("early");
    expect(pool().session.attached[0]!.target).toEqual({ remoteHost: "127.0.0.1", remotePort: 5432 });
    expect(pool().acquired).toEqual(["stream"]);
    client.destroy();
    await pool().waitFor("release", () => pool().released.length === 1);
  });

  it("destroys the socket when the pool refuses it", async () => {
    const m = newManager();
    const cfg = await forward("prod-db");
    await m.add(cfg);
    pool().error = new PoolError("expired", "max duration");
    const client = await connect(cfg.local_port);
    await closed(client);
    expect(pool().session.attached).toHaveLength(0);
  });

  it("counts bytes in each direction", async () => {
    const m = newManager();
    const cfg = await forward("prod-db");
    await m.add(cfg);
    pool().session.echo = true;
    const client = await connect(cfg.local_port);
    const echoed = new Promise<void>((resolve) => client.once("data", () => resolve()));
    client.write("12345");
    await echoed;
    expect(m.get("prod-db").traffic).toMatchObject({ bytes_in: 5, bytes_out: 5, streams: 1 });
    client.destroy();
    await pool().waitFor("release", () => pool().released.length === 1);
    expect(m.get("prod-db").traffic).toEqual({ bytes_in: 5, bytes_out: 5, streams: 0 });
  });

  it("shares one pool between tunnels to one server and uses another for a second server", async () => {
    const m = newManager();
    await m.add(await forward("a"));
    await m.add(await forward("b"));
    await m.add(await forward("c", { server_id: "s2", server: "prod-2" }));
    expect(keys.map((k) => k.server_id)).toEqual(["s1", "s2"]);
  });

  it("reports a port that is already in use as failed with the reason", async () => {
    const m = newManager();
    const taken = net.createServer();
    const port = await new Promise<number>((r) => taken.listen(0, "127.0.0.1", () => r((taken.address() as net.AddressInfo).port)));
    const view = await m.add({ ...(await forward("prod-db")), local_port: port });
    expect(view.state).toBe("failed");
    expect(view.detail).toBe(`local port ${port} is already in use`);
    await new Promise<void>((r) => taken.close(() => r()));
  });
});

describe("forward UDP", () => {
  it("drops the first datagram while it opens the session, then forwards through the listener", async () => {
    const m = newManager();
    const cfg = await forward("dns", { kind: "udp", target: "10.0.0.2:53" });
    await m.add(cfg);
    const peer = dgram.createSocket("udp4");
    peer.send("one", cfg.local_port, "127.0.0.1");
    await pool().waitFor("acquire", () => pool().acquired.length > 0);
    expect(pool().acquired).toEqual(["stream"]);
    expect(pool().session.datagrams).toHaveLength(0);
    await pool().waitFor("release", () => pool().released.length === 1);
    pool().setState({ state: "active" });
    peer.send("two", cfg.local_port, "127.0.0.1");
    await pool().session.waitFor("datagram", () => pool().session.datagrams.length === 1);
    expect(pool().session.datagrams[0]!.buf.toString()).toBe("two");
    expect(pool().session.datagrams[0]!.target).toEqual({ remoteHost: "10.0.0.2", remotePort: 53 });
    expect(pool().touches).toBe(1);
    peer.close();
  });
});

describe("saved state", () => {
  it("saves a tunnel and picks the target port when it is free", async () => {
    const m = newManager();
    const free = await freePort();
    const view = await m.add({ ...base, name: "prod-db", kind: "tcp", target: `127.0.0.1:${free}` });
    expect(view.local_port).toBe(free);
    expect(loadConfig(configPath).tunnels[0]).toMatchObject({ name: "prod-db", local_port: free, enabled: true });
  });

  it("picks another port when the target port is taken", async () => {
    const m = newManager();
    const taken = net.createServer();
    const busy = await new Promise<number>((r) => taken.listen(0, "127.0.0.1", () => r((taken.address() as net.AddressInfo).port)));
    const view = await m.add({ ...base, name: "prod-db", kind: "tcp", target: `127.0.0.1:${busy}` });
    expect(view.local_port).not.toBe(busy);
    expect(view.state).not.toBe("failed");
    await new Promise<void>((r) => taken.close(() => r()));
  });

  it("rejects duplicates, bad input and later-phase fields", async () => {
    const m = newManager();
    const cfg = await forward("prod-db");
    await m.add(cfg);
    expect(await rejectionOf(m.add({ ...cfg, local_port: await freePort() }))).toMatchObject({ code: "conflict" });
    expect(await rejectionOf(m.add({ ...cfg, name: "other" }))).toMatchObject({ code: "conflict" });
    expect(await rejectionOf(m.add({ ...cfg, name: "Bad Name" }))).toMatchObject({ code: "invalid" });
    expect(messageOf(await rejectionOf(m.add({ ...cfg, name: "x", kind: "https" })))).toMatch(/phase 2/);
    expect(await rejectionOf(m.add("nope"))).toBeInstanceOf(ManagerError);
  });

  it("does not bring a tunnel up when it is saved with enabled: false", async () => {
    const m = newManager();
    const cfg = await forward("prod-db", { enabled: false });
    const view = await m.add(cfg);
    expect(view.state).toBe("down");
    expect(await rejectionOf(connect(cfg.local_port))).toBeDefined();
    expect(keys).toHaveLength(0);
  });

  it("down closes the listener and persists, up brings it back", async () => {
    const m = newManager();
    const cfg = await forward("prod-db");
    await m.add(cfg);
    const down = await m.down("prod-db");
    expect(down.state).toBe("down");
    expect(loadConfig(configPath).tunnels[0]!.enabled).toBe(false);
    expect(await rejectionOf(connect(cfg.local_port))).toBeDefined();
    expect(pool().stopped).toBe(true);
    const up = await m.up("prod-db");
    expect(up.state).toBe("ready");
    expect(loadConfig(configPath).tunnels[0]!.enabled).toBe(true);
    (await connect(cfg.local_port)).destroy();
  });

  it("restores the enabled tunnels after a restart and leaves the disabled ones down", async () => {
    const first = newManager();
    const a = await forward("a");
    const b = await forward("b");
    await first.add(a);
    await first.add(b);
    await first.down("b");
    await first.stop();
    const second = newManager();
    await second.start();
    expect(second.list().map((t) => [t.name, t.state])).toEqual([
      ["a", "ready"],
      ["b", "down"],
    ]);
    (await connect(a.local_port)).destroy();
    expect(await rejectionOf(connect(b.local_port))).toBeDefined();
  });

  it("keeps the saved desired state when the manager stops", async () => {
    const m = newManager();
    await m.add(await forward("prod-db"));
    await m.stop();
    expect(loadConfig(configPath).tunnels[0]!.enabled).toBe(true);
  });

  it("edits a tunnel and rebinds it when it is up", async () => {
    const m = newManager();
    const cfg = await forward("prod-db");
    await m.add(cfg);
    const newPort = await freePort();
    const view = await m.edit("prod-db", { local_port: newPort, target: "10.0.0.9:6379" });
    expect(view).toMatchObject({ local_port: newPort, target: "10.0.0.9:6379", state: "ready" });
    expect(await rejectionOf(connect(cfg.local_port))).toBeDefined();
    (await connect(newPort)).destroy();
    expect(loadConfig(configPath).tunnels[0]).toMatchObject({ local_port: newPort });
  });

  it("refuses to rename or change the kind, and reports an unknown tunnel", async () => {
    const m = newManager();
    await m.add(await forward("prod-db"));
    expect(await rejectionOf(m.edit("prod-db", { name: "x" }))).toMatchObject({ code: "invalid" });
    expect(await rejectionOf(m.edit("prod-db", { kind: "udp" }))).toMatchObject({ code: "invalid" });
    expect(await rejectionOf(m.edit("nope", {}))).toMatchObject({ code: "not_found" });
    expect(await rejectionOf(m.up("nope"))).toMatchObject({ code: "not_found" });
  });

  it("removes a tunnel from the file and closes its listener", async () => {
    const m = newManager();
    const cfg = await forward("prod-db");
    const events: ManagerEvent[] = [];
    m.onEvent((e) => events.push(e));
    await m.add(cfg);
    await m.remove("prod-db");
    expect(loadConfig(configPath).tunnels).toEqual([]);
    expect(m.list()).toEqual([]);
    expect(await rejectionOf(connect(cfg.local_port))).toBeDefined();
    expect(events).toContainEqual({ type: "tunnel", name: "prod-db", removed: true });
  });
});

describe("states", () => {
  it("shows the pool's state on every tunnel to that server", async () => {
    const m = newManager();
    await m.add(await forward("a"));
    await m.add(await forward("b"));
    pool().setState({ state: "active" });
    expect(m.list().map((t) => t.state)).toEqual(["active", "active"]);
    pool().setState({ state: "expired", detail: "max duration" });
    const [a] = m.list();
    expect(a).toMatchObject({ state: "expired", detail: "max duration", action: "Run reoclo tunnel up <name>" });
  });

  it("clears the pool's terminal state when any tunnel of the server is brought up", async () => {
    const m = newManager();
    await m.add(await forward("a"));
    await m.add(await forward("b", { enabled: false }));
    const before = pool().resets;
    await m.up("b");
    expect(pool().resets).toBe(before + 1);
  });

  it("emits a tunnel event when the pool changes", async () => {
    const m = newManager();
    await m.add(await forward("a"));
    const events: ManagerEvent[] = [];
    m.onEvent((e) => events.push(e));
    pool().setState({ state: "connecting" });
    expect(events.some((e) => e.type === "tunnel" && e.tunnel?.state === "connecting")).toBe(true);
  });

  it("lists only active tunnels in the traffic snapshot", async () => {
    const m = newManager();
    await m.add(await forward("a"));
    expect(m.trafficSnapshot()).toEqual([]);
    pool().setState({ state: "active" });
    expect(m.trafficSnapshot().map((t) => t.name)).toEqual(["a"]);
  });
});

describe("keep-up and reverse tunnels", () => {
  it("holds the session for a keep-up tunnel and releases it on down", async () => {
    const m = newManager();
    await m.add(await forward("prod-db", { keep_up: true }));
    await pool().waitFor("acquire", () => pool().acquired.length === 1);
    expect(pool().acquired).toEqual(["hold"]);
    await m.down("prod-db");
    expect(pool().released).toEqual(["hold"]);
  });

  it("does not hold the session for an on-demand tunnel", async () => {
    const m = newManager();
    await m.add(await forward("prod-db"));
    expect(pool().acquired).toEqual([]);
  });

  it("registers a reverse listener, shows connecting until it is bound, and removes it on down", async () => {
    const m = newManager();
    const view = await m.add({ ...base, name: "hook", kind: "reverse", remote_port: 8080, local_target: "127.0.0.1:3000" });
    expect(view.kind).toBe("reverse");
    await pool().session.waitFor("reverse", () => pool().session.reverses.length === 1);
    expect(pool().session.reverses[0]!.spec).toEqual({
      remoteBind: "127.0.0.1",
      remotePort: 8080,
      localHost: "127.0.0.1",
      localPort: 3000,
      proto: "tcp",
    });
    expect(pool().acquired).toEqual(["hold"]);
    await m.down("hook");
    expect(pool().session.removedReverses).toEqual(["l-1"]);
    expect(pool().released).toEqual(["hold"]);
  });

  it("binds 0.0.0.0 on the server only when asked", async () => {
    const m = newManager();
    await m.add({ ...base, name: "hook", kind: "reverse", remote_port: 8080, local_target: "127.0.0.1:3000", bind_public: true });
    await pool().session.waitFor("reverse", () => pool().session.reverses.length === 1);
    expect(pool().session.reverses[0]!.spec.remoteBind).toBe("0.0.0.0");
  });

  it("shows the runner's refusal of a reverse listener and stops retrying", async () => {
    const m = newManager();
    const failing = new FakePool();
    failing.session.addReverse = () =>
      Promise.reject(new Error("reverse tunnels are disabled by your organization's policy"));
    pools.set("s1", failing);
    await m.add({ ...base, name: "hook", kind: "reverse", remote_port: 8080, local_target: "127.0.0.1:3000" });
    await failing.waitFor("release", () => failing.released.length === 1);
    expect(m.get("hook")).toMatchObject({ state: "forbidden" });
    expect(m.get("hook").detail).toContain("disabled");
    expect(timers.pending.size).toBe(0);
  });

  it("retries a held tunnel with a growing delay while the runner stays offline", async () => {
    const m = newManager();
    await m.add(await forward("prod-db", { keep_up: true }));
    await pool().waitFor("acquire", () => pool().acquired.length === 1);
    pool().setState({ state: "server_offline", detail: "runner gone" });
    expect(timers.delays).toEqual([1000]);
    const rescheduled = new Promise<void>((resolve) => {
      const off = m.onEvent(() => {
        if (timers.delays.length !== 2) return;
        off();
        resolve();
      });
    });
    pool().error = new PoolError("server_offline", "still gone");
    timers.fire();
    await rescheduled;
    expect(pool().acquired).toHaveLength(2);
    expect(timers.delays).toEqual([1000, 2000]);
  });

  it("starts the delay over once a retry connects", async () => {
    const m = newManager();
    await m.add(await forward("prod-db", { keep_up: true }));
    await pool().waitFor("acquire", () => pool().acquired.length === 1);
    pool().setState({ state: "server_offline" });
    timers.fire();
    await pool().waitFor("acquire", () => pool().acquired.length === 2);
    pool().setState({ state: "server_offline" });
    expect(timers.delays).toEqual([1000, 1000]);
  });

  it("does not retry after a terminal or sign-in state", async () => {
    const m = newManager();
    await m.add(await forward("prod-db", { keep_up: true }));
    await pool().waitFor("acquire", () => pool().acquired.length === 1);
    for (const state of ["expired", "closed_by_operator", "needs_sign_in", "forbidden", "quota_reached"] as const) {
      pool().setState({ state });
    }
    expect(timers.pending.size).toBe(0);
  });
});
