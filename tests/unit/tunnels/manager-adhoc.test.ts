import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../../src/tunnels/config";
import {
  MAX_ADHOC_TTL_MINUTES,
  TunnelManager,
  type AdHocInput,
  type ManagerOptions,
} from "../../../src/tunnels/manager";
import { PoolError } from "../../../src/tunnels/pool";
import { FakePool, ManualTimers } from "../../helpers/fake-pool";
import { freePort } from "../../helpers/fake-ws-gateway";
import { rejectionOf } from "../../helpers/rejection";

class IdlePool extends FakePool {
  idle: number[] = [];
  setIdleTimeout(ms: number): void {
    this.idle.push(ms);
  }
}

let dir: string;
let configPath: string;
let managers: TunnelManager[];
let pools: Map<string, FakePool>;
let timers: ManualTimers;
let now: number;

function newManager(extra: Partial<ManagerOptions> = {}): TunnelManager {
  const m = new TunnelManager({
    configPath,
    timers,
    now: () => now,
    createPool: (key) => {
      const pool = pools.get(key.server_id) ?? new FakePool();
      pools.set(key.server_id, pool);
      return pool;
    },
    ...extra,
  });
  managers.push(m);
  return m;
}

const base = { org: "acme", tenant_id: "t1", server: "prod-1", server_id: "s1" };
const adhoc = (extra: Partial<AdHocInput> = {}): AdHocInput => ({
  ...base,
  target: "127.0.0.1:5432",
  kind: "tcp",
  ttl_minutes: 60,
  ...extra,
});

function removed(m: TunnelManager, name: string): Promise<void> {
  return new Promise((resolve) => {
    const off = m.onEvent((e) => {
      if (e.type === "tunnel" && e.removed && e.name === name) {
        off();
        resolve();
      }
    });
  });
}

function refused(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      reject(new Error(`port ${port} still accepts connections`));
    });
    s.once("error", () => resolve());
  });
}

function accepts(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      resolve();
    });
    s.once("error", reject);
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reoclo-adhoc-"));
  configPath = join(dir, "tunnels.yaml");
  managers = [];
  pools = new Map();
  timers = new ManualTimers();
  now = Date.parse("2026-11-09T10:00:00Z");
});
afterEach(async () => {
  for (const m of managers) await m.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("ad-hoc tunnels", () => {
  it("listens on a picked loopback port, checks the session, and is never saved", async () => {
    const port = await freePort();
    const m = newManager({ pickPort: () => Promise.resolve(port) });
    const view = await m.openAdHoc(adhoc());
    expect(view).toMatchObject({ adhoc: true, kind: "tcp", endpoint: `127.0.0.1:${port}`, local_port: port, state: "ready" });
    expect(view.name).toMatch(/^adhoc-[0-9a-f]{6}$/);
    expect(view.expires_at).toBe(new Date(now + 3_600_000).toISOString());
    expect(pools.get("s1")?.acquired).toEqual(["stream"]);
    expect(pools.get("s1")?.released).toEqual(["stream"]);
    expect(loadConfig(configPath).tunnels).toEqual([]);
    expect(m.list().map((t) => t.name)).toEqual([view.name]);
    await accepts(port);
  });

  it("asks for a free port and avoids the ones tunnels already use", async () => {
    const m = newManager();
    const saved = await freePort();
    await m.add({ ...base, name: "db", kind: "tcp", target: "127.0.0.1:5432", local_port: saved });
    const a = await m.openAdHoc(adhoc());
    const b = await m.openAdHoc(adhoc());
    const ports = [saved, a.local_port, b.local_port];
    expect(new Set(ports).size).toBe(3);
  });

  it("ends at its time to live and frees the port", async () => {
    const m = newManager();
    const view = await m.openAdHoc(adhoc({ ttl_minutes: 5 }));
    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([300_000]);
    const gone = removed(m, view.name);
    timers.fire();
    await gone;
    expect(m.list()).toEqual([]);
    await refused(view.local_port ?? 0);
  });

  it("ends early when the agent closes it, and cancels the expiry", async () => {
    const m = newManager();
    const view = await m.openAdHoc(adhoc());
    const closed = await m.down(view.name);
    expect(closed).toMatchObject({ adhoc: true, state: "down" });
    expect(m.list()).toEqual([]);
    expect(timers.pending.size).toBe(0);
    await refused(view.local_port ?? 0);
  });

  it("ends when removed, and refuses edits", async () => {
    const m = newManager();
    const a = await m.openAdHoc(adhoc());
    expect(await rejectionOf(m.edit(a.name, { target: "10.0.0.1:80" }))).toMatchObject({ code: "invalid" });
    await m.remove(a.name);
    expect(m.list()).toEqual([]);
  });

  it("accepts udp", async () => {
    const m = newManager();
    const view = await m.openAdHoc(adhoc({ kind: "udp", target: "127.0.0.1:53" }));
    expect(view.kind).toBe("udp");
  });

  it("rejects a time to live outside 1 to 480 minutes", async () => {
    const m = newManager();
    for (const ttl of [0, MAX_ADHOC_TTL_MINUTES + 1, 1.5, -3]) {
      expect(await rejectionOf(m.openAdHoc(adhoc({ ttl_minutes: ttl })))).toMatchObject({ code: "invalid" });
    }
    expect(m.list()).toEqual([]);
  });

  it("rejects a target that is not HOST:PORT", async () => {
    const m = newManager();
    expect(await rejectionOf(m.openAdHoc(adhoc({ target: "no-port" })))).toMatchObject({ code: "invalid" });
  });

  it("maps a connection failure to an error and keeps nothing", async () => {
    const cases: Array<[PoolError, string, string]> = [
      [new PoolError("needs_sign_in", "session expired"), "unauthorized", "needs_sign_in"],
      [new PoolError("forbidden", "refused"), "forbidden", "forbidden"],
      [new PoolError("server_offline", "runner gone"), "upstream", "server_offline"],
    ];
    for (const [poolError, code, state] of cases) {
      const pool = new FakePool();
      pool.error = poolError;
      pools.set("s1", pool);
      const port = await freePort();
      const m = newManager({ pickPort: () => Promise.resolve(port) });
      const err = await rejectionOf(m.openAdHoc(adhoc()));
      expect(err).toMatchObject({ code, state });
      expect(m.list()).toEqual([]);
      await refused(port);
      pools.clear();
    }
  });

  it("gives up after the connect wait and releases a session that opens late", async () => {
    const pool = new FakePool();
    let open!: () => void;
    pool.gate = new Promise<void>((r) => (open = r));
    pools.set("s1", pool);
    const m = newManager({ connectTimeoutMs: 30_000 });
    const opening = m.openAdHoc(adhoc());
    await pool.waitFor("acquire", () => pool.acquired.length === 1);
    const [id, verifyTimer] = [...timers.pending.entries()].find(([, t]) => t.ms === 30_000) ?? [];
    expect(verifyTimer).toBeDefined();
    timers.pending.delete(id as number);
    verifyTimer?.fn();
    expect(await rejectionOf(opening)).toMatchObject({ code: "upstream", state: "connecting" });
    expect(m.list()).toEqual([]);
    open();
    await pool.waitFor("release", () => pool.released.length === 1);
  });
});

describe("up with verify", () => {
  it("opens and releases a session, so a saved tunnel's failure reaches the caller", async () => {
    const m = newManager();
    await m.add({ ...base, name: "db", kind: "tcp", target: "127.0.0.1:5432", local_port: await freePort() });
    const pool = pools.get("s1") as FakePool;
    await m.up("db", { verify: true });
    expect(pool.acquired).toEqual(["stream"]);
    expect(pool.released).toEqual(["stream"]);

    pool.error = new PoolError("server_offline", "runner gone");
    expect(await rejectionOf(m.up("db", { verify: true }))).toMatchObject({ code: "upstream", state: "server_offline" });
    expect(m.get("db").enabled).toBe(true);
  });

  it("does not open a session without verify", async () => {
    const m = newManager();
    await m.add({ ...base, name: "db", kind: "tcp", target: "127.0.0.1:5432", local_port: await freePort() });
    await m.up("db");
    expect(pools.get("s1")?.acquired).toEqual([]);
  });
});

describe("settings", () => {
  it("changes agent approvals and the idle timeout, and tells the open pools", async () => {
    const pool = new IdlePool();
    pools.set("s1", pool);
    const m = newManager();
    await m.add({ ...base, name: "db", kind: "tcp", target: "127.0.0.1:5432", local_port: await freePort() });
    expect(m.settings()).toMatchObject({ agent_approvals: "required", idle_timeout_seconds: 600 });
    const next = await m.updateSettings({ agent_approvals: "off", idle_timeout_seconds: 30 });
    expect(next).toMatchObject({ agent_approvals: "off", idle_timeout_seconds: 30 });
    expect(pool.idle).toEqual([30_000]);
    expect(loadConfig(configPath)).toMatchObject({ agent_approvals: "off", idle_timeout_seconds: 30 });
  });

  it("rejects values it cannot use", async () => {
    const m = newManager();
    expect(await rejectionOf(m.updateSettings({ agent_approvals: "sometimes" }))).toMatchObject({ code: "invalid" });
    expect(await rejectionOf(m.updateSettings({ idle_timeout_seconds: 0 }))).toMatchObject({ code: "invalid" });
    expect(m.settings().agent_approvals).toBe("required");
  });
});
