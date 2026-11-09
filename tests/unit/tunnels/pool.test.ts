import { describe, expect, it } from "bun:test";
import { ReauthRequiredError } from "../../../src/client/errors";
import { PoolError, ServerPool, type PoolState, type StatusCallback } from "../../../src/tunnels/pool";
import { FakeSession, ManualTimers } from "../../helpers/fake-pool";
import { rejectionOf } from "../../helpers/rejection";

function setup(idleTimeoutMs = 600_000) {
  const timers = new ManualTimers();
  const sessions: FakeSession[] = [];
  const states: PoolState[] = [];
  const opts: { startGate?: Promise<void>; startError?: Error; createError?: Error } = {};
  const pool = new ServerPool({
    idleTimeoutMs,
    timers,
    createSession: (onStatus: StatusCallback) => {
      if (opts.createError) return Promise.reject(opts.createError);
      const s = new FakeSession(onStatus);
      s.startGate = opts.startGate;
      s.startError = opts.startError;
      sessions.push(s);
      return Promise.resolve(s);
    },
  });
  pool.onChange((s) => states.push(s));
  return { pool, timers, sessions, states, opts };
}

describe("ServerPool connect", () => {
  it("shares one connect between concurrent acquires", async () => {
    const t = setup();
    let release!: () => void;
    t.opts.startGate = new Promise<void>((r) => (release = r));
    const a = t.pool.acquire("stream");
    const b = t.pool.acquire("stream");
    expect(t.pool.state.state).toBe("connecting");
    release();
    const [la, lb] = await Promise.all([a, b]);
    expect(t.sessions).toHaveLength(1);
    expect(la.session).toBe(lb.session);
    expect(t.pool.state.state).toBe("active");
    expect(t.pool.streamCount).toBe(2);
  });

  it("reuses the open session for later acquires", async () => {
    const t = setup();
    const a = await t.pool.acquire("stream");
    const b = await t.pool.acquire("hold");
    expect(a.session).toBe(b.session);
    expect(t.sessions).toHaveLength(1);
    expect(t.pool.holdCount).toBe(1);
  });

  it("exposes the session through activeSession only while it is active", async () => {
    const t = setup();
    expect(t.pool.activeSession()).toBeUndefined();
    const lease = await t.pool.acquire("stream");
    expect(t.pool.activeSession()).toBe(lease.session);
    t.sessions[0]!.status("reconnecting", "1006");
    expect(t.pool.activeSession()).toBeUndefined();
  });
});

describe("ServerPool idle close", () => {
  it("closes the session after the idle timeout and reopens on the next acquire", async () => {
    const t = setup(1234);
    const lease = await t.pool.acquire("stream");
    expect(t.timers.pending.size).toBe(0);
    lease.release();
    expect([...t.timers.pending.values()].map((x) => x.ms)).toEqual([1234]);
    t.timers.fire();
    await Promise.resolve();
    expect(t.sessions[0]!.stopped).toBe(true);
    expect(t.pool.state.state).toBe("ready");
    expect(t.pool.activeSession()).toBeUndefined();
    await t.pool.acquire("stream");
    expect(t.sessions).toHaveLength(2);
    expect(t.pool.state.state).toBe("active");
  });

  it("does not arm the timer while a stream is open", async () => {
    const t = setup();
    const a = await t.pool.acquire("stream");
    const b = await t.pool.acquire("stream");
    a.release();
    expect(t.timers.pending.size).toBe(0);
    b.release();
    expect(t.timers.pending.size).toBe(1);
  });

  it("never idles while a keep-up hold exists", async () => {
    const t = setup();
    const hold = await t.pool.acquire("hold");
    const stream = await t.pool.acquire("stream");
    stream.release();
    expect(t.timers.pending.size).toBe(0);
    hold.release();
    expect(t.timers.pending.size).toBe(1);
  });

  it("ignores a double release", async () => {
    const t = setup();
    const a = await t.pool.acquire("stream");
    await t.pool.acquire("stream");
    a.release();
    a.release();
    expect(t.pool.streamCount).toBe(1);
  });

  it("restarts the timer on touch() so datagram traffic keeps the session open", async () => {
    const t = setup(500);
    (await t.pool.acquire("stream")).release();
    const first = [...t.timers.pending.keys()];
    t.pool.touch();
    expect(t.timers.pending.size).toBe(1);
    expect([...t.timers.pending.keys()]).not.toEqual(first);
    expect(t.timers.delays).toEqual([500, 500]);
  });

  it("does nothing on touch() when the timer is not armed", async () => {
    const t = setup();
    await t.pool.acquire("stream");
    t.pool.touch();
    expect(t.timers.pending.size).toBe(0);
  });
});

describe("ServerPool failures", () => {
  it("moves to expired on 4408, drops the session and refuses to reopen until reset", async () => {
    const t = setup();
    await t.pool.acquire("stream");
    t.sessions[0]!.status("failed", "max duration", 4408);
    expect(t.pool.state).toEqual({ state: "expired", detail: "max duration" });
    expect(t.sessions[0]!.stopped).toBe(true);
    expect(await rejectionOf(t.pool.acquire("stream"))).toMatchObject({ name: "PoolError", state: "expired" });
    expect(t.sessions).toHaveLength(1);
    t.pool.reset();
    expect(t.pool.state.state).toBe("ready");
    await t.pool.acquire("stream");
    expect(t.sessions).toHaveLength(2);
  });

  it("moves to closed_by_operator on 4407 and stays until reset", async () => {
    const t = setup();
    await t.pool.acquire("hold");
    t.sessions[0]!.status("failed", "closed", 4407);
    expect(t.pool.state.state).toBe("closed_by_operator");
    expect(await rejectionOf(t.pool.acquire("hold"))).toBeInstanceOf(PoolError);
    t.pool.reset();
    await t.pool.acquire("hold");
    expect(t.pool.state.state).toBe("active");
  });

  it("retries on the next acquire after a non-terminal failure", async () => {
    const t = setup();
    await t.pool.acquire("stream");
    t.sessions[0]!.status("failed", "runner gone", 4410);
    expect(t.pool.state.state).toBe("server_offline");
    await t.pool.acquire("stream");
    expect(t.sessions).toHaveLength(2);
    expect(t.pool.state.state).toBe("active");
  });

  it("maps the other close codes", async () => {
    for (const [code, state] of [
      [4401, "needs_sign_in"],
      [4429, "quota_reached"],
      [4403, "forbidden"],
      [4503, "failed"],
    ] as const) {
      const t = setup();
      await t.pool.acquire("stream");
      t.sessions[0]!.status("failed", "x", code);
      expect(t.pool.state.state).toBe(state);
    }
  });

  it("voids old leases when the session fails", async () => {
    const t = setup();
    const old = await t.pool.acquire("stream");
    t.sessions[0]!.status("failed", "gone", 4410);
    expect(t.pool.streamCount).toBe(0);
    await t.pool.acquire("stream");
    old.release();
    expect(t.pool.streamCount).toBe(1);
  });

  it("reports the failure state when the connect itself is refused", async () => {
    const t = setup();
    t.opts.startError = new Error("Unexpected server response: 401");
    expect(await rejectionOf(t.pool.acquire("stream"))).toMatchObject({ state: "needs_sign_in" });
    expect(t.pool.state.state).toBe("needs_sign_in");
    expect(t.sessions[0]!.stopped).toBe(true);
  });

  it("reports needs_sign_in when signing in fails", async () => {
    const t = setup();
    t.opts.createError = new ReauthRequiredError("default", "rejected");
    expect(await rejectionOf(t.pool.acquire("stream"))).toMatchObject({ state: "needs_sign_in" });
    expect(t.pool.state.state).toBe("needs_sign_in");
  });

  it("surfaces a close that arrives while connecting", async () => {
    const t = setup();
    let release!: () => void;
    t.opts.startGate = new Promise<void>((r) => (release = r));
    const attempt = t.pool.acquire("stream");
    await Promise.resolve();
    await Promise.resolve();
    t.sessions[0]!.status("failed", "runner gone", 4410);
    release();
    expect(await rejectionOf(attempt)).toMatchObject({ state: "server_offline" });
  });

  it("refuses acquires while the session is reconnecting and accepts them again once active", async () => {
    const t = setup();
    await t.pool.acquire("stream");
    t.sessions[0]!.status("reconnecting", "1006");
    expect(t.pool.state).toEqual({ state: "reconnecting", detail: "1006" });
    expect(await rejectionOf(t.pool.acquire("stream"))).toMatchObject({ state: "reconnecting" });
    t.sessions[0]!.status("active");
    expect(t.pool.state.state).toBe("active");
    await t.pool.acquire("stream");
    expect(t.sessions).toHaveLength(1);
  });

  it("ignores status callbacks from a session it already replaced", async () => {
    const t = setup(1);
    (await t.pool.acquire("stream")).release();
    t.timers.fire();
    await Promise.resolve();
    await t.pool.acquire("stream");
    t.sessions[0]!.status("failed", "late", 4408);
    expect(t.pool.state.state).toBe("active");
  });
});

describe("ServerPool stop and events", () => {
  it("stops the session and refuses new work", async () => {
    const t = setup();
    await t.pool.acquire("stream");
    await t.pool.stop();
    expect(t.sessions[0]!.stopped).toBe(true);
    expect(await rejectionOf(t.pool.acquire("stream"))).toBeInstanceOf(PoolError);
  });

  it("notifies on each state change", async () => {
    const t = setup();
    await t.pool.acquire("stream");
    t.sessions[0]!.status("failed", "x", 4410);
    expect(t.states.map((s) => s.state)).toEqual(["connecting", "active", "server_offline"]);
  });
});
