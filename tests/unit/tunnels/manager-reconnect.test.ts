import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TunnelManager, type TunnelView } from "../../../src/tunnels/manager";
import { ServerPool } from "../../../src/tunnels/pool";
import { FakeSession, ManualTimers } from "../../helpers/fake-pool";
import { freePort } from "../../helpers/fake-ws-gateway";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function setup(random: () => number = () => 1) {
  const dir = mkdtempSync(join(tmpdir(), "reoclo-reconnect-"));
  const timers = new ManualTimers();
  const sessions: FakeSession[] = [];
  const failure: { error?: Error } = {};
  const pool = new ServerPool({
    idleTimeoutMs: 600_000,
    timers,
    createSession: (onStatus) => {
      const session = new FakeSession(onStatus);
      session.startError = failure.error;
      sessions.push(session);
      return Promise.resolve(session);
    },
  });
  const manager = new TunnelManager({
    configPath: join(dir, "tunnels.yaml"), timers, now: () => 1_000_000,
    random, createPool: () => pool,
  });
  cleanup.push(async () => { await manager.stop(); rmSync(dir, { recursive: true, force: true }); });
  await manager.add({
    name: "db", org: "acme", tenant_id: "t1", server: "prod", server_id: "s1",
    kind: "tcp", target: "127.0.0.1:5432", local_port: await freePort(), keep_up: false,
  });
  await manager.up("db", { verify: true });
  return { manager, timers, sessions, failure };
}

function changed(manager: TunnelManager, predicate: (view: TunnelView) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error("tunnel transition timed out")); }, 2000);
    const off = manager.onEvent((event) => {
      if (event.type === "tunnel" && event.tunnel && predicate(event.tunnel)) {
        clearTimeout(timer); off(); resolve();
      }
    });
  });
}

it.each([4410, 4503, 4408])("recovers an enabled on-demand tunnel after close %i", async (code) => {
  const t = await setup();
  t.sessions[0]?.status("failed", "session ended", code);
  expect(t.manager.get("db").retry).toEqual({ attempt: 1, next_at: "1970-01-01T00:16:41.000Z" });
  const active = changed(t.manager, (view) => view.state === "active");
  t.timers.fire();
  await active;
  expect(t.sessions).toHaveLength(2);
  expect(t.manager.get("db").retry).toBeUndefined();
});

it("backs off repeated pool failures without requiring a client connection", async () => {
  const t = await setup();
  const start = t.timers.delays.length;
  t.sessions[0]?.status("failed", "lost", 4503);
  t.failure.error = new Error("Unexpected server response: 502");
  for (const attempt of [2, 3, 4, 5, 6, 7]) {
    const scheduled = changed(t.manager, (view) => view.retry?.attempt === attempt);
    t.timers.fire();
    await scheduled;
  }
  expect(t.timers.delays.slice(start)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

it("jitters retries within the exponential window", async () => {
  const t = await setup(() => 0);
  t.sessions[0]?.status("failed", "lost", 4503);
  t.failure.error = new Error("Unexpected server response: 502");
  const scheduled = changed(t.manager, (view) => view.retry?.attempt === 2);
  t.timers.fire();
  await scheduled;
  expect(t.manager.get("db").retry?.next_at).toBe("1970-01-01T00:16:41.500Z");
});

it("Retry now cancels the delayed retry and opens a fresh session", async () => {
  const t = await setup();
  t.sessions[0]?.status("failed", "expired", 4408);
  await t.manager.up("db", { verify: true });
  expect(t.manager.get("db").state).toBe("active");
  expect(t.manager.get("db").retry).toBeUndefined();
  expect(t.sessions).toHaveLength(2);
});

it.each(["down", "remove", "stop"] as const)("cancels recovery on %s", async (operation) => {
  const t = await setup();
  t.sessions[0]?.status("failed", "lost", 4503);
  switch (operation) {
    case "down": await t.manager.down("db"); break;
    case "remove": await t.manager.remove("db"); break;
    case "stop": await t.manager.stop(); break;
  }
  expect(t.timers.pending.size).toBe(0);
  t.timers.fire();
  expect(t.sessions).toHaveLength(1);
});

it.each([4401, 4403, 4407, 4429])("does not retry a policy or authorization closure %i", async (code) => {
  const t = await setup();
  t.sessions[0]?.status("failed", "requires intervention", code);
  expect(t.manager.get("db").retry).toBeUndefined();
  expect(t.timers.pending.size).toBe(0);
});
