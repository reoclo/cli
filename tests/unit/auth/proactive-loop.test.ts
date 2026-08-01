import { test, expect } from "bun:test";
import { startTokenRefreshLoop } from "../../../src/auth/proactive";

test("startTokenRefreshLoop refreshes at expiry-skew and re-arms from the new expiry", async () => {
  const t0 = Date.parse("2026-08-01T12:00:00.000Z");
  const nowMs = t0;
  const timers: Array<{ fn: () => void; at: number }> = [];
  let received: string | undefined;
  const expiries = ["2026-08-01T12:10:00.000Z", "2026-08-01T13:10:00.000Z"]; // after each refresh
  let refreshCount = 0;

  const stop = startTokenRefreshLoop({
    refresh: () => { refreshCount += 1; return Promise.resolve(`tok-${refreshCount}`); },
    onToken: (t) => { received = t; },
    // Indexed by "which refresh cycle this is" (0-based): getExpiresAt is
    // always called right after refresh() increments refreshCount, so
    // refreshCount - 1 is the completed cycle whose post-refresh expiry we want.
    getExpiresAt: () =>
      Promise.resolve(expiries[Math.min(Math.max(0, refreshCount - 1), expiries.length - 1)]),
    initialToken: "tok-0",
    initialExpiresAt: "2026-08-01T12:02:00.000Z", // 2m out, skew 120s → due immediately (delay 0)
    skewMs: 120_000,
    now: () => nowMs,
    setTimer: (fn, ms) => { timers.push({ fn, at: nowMs + ms }); return timers.length - 1; },
    clearTimer: () => {},
  });

  // First timer scheduled at delay 0 (due now). Fire it.
  expect(timers.length).toBe(1);
  // fn is typed () => void per TokenRefreshLoopDeps, but the loop's real callback
  // returns tick()'s promise so a mock setTimer can capture it; awaiting here
  // deterministically drains the refresh-then-rearm chain before the assertions.
  // eslint-disable-next-line @typescript-eslint/await-thenable
  await timers[0]!.fn();                 // runs the refresh, then re-arms
  expect(refreshCount).toBe(1);
  expect(received).toBe("tok-1");
  // Re-armed from new expiry 12:10 → delay 12:10 - skew - now(12:00) = 8m.
  expect(timers.length).toBe(2);
  expect(timers[1]!.at - t0).toBe(8 * 60_000);
  stop();
});

test("startTokenRefreshLoop refreshes with the rotated token on cycle 2, not the frozen initial token (regression)", async () => {
  // Guards the fix: the loop now tracks the current token internally (seeded
  // from initialToken, updated on each successful refresh) instead of asking
  // the caller for it via a currentToken() getter. The old design let a caller
  // wire that getter to a snapshot that never changes (as mcp.ts did with
  // ctx.token) while onToken wrote the fresh token somewhere else entirely, so
  // every refresh after the first reused the stale initial token forever. Here,
  // onToken is a no-op that writes nowhere the loop can read from, proving the
  // rotation is owned internally and cannot drift.
  const timers: Array<() => void> = [];
  const calledWith: string[] = [];
  const stop = startTokenRefreshLoop({
    refresh: (currentToken) => {
      calledWith.push(currentToken);
      return Promise.resolve(`t${calledWith.length}`); // cycle 1 → "t1", cycle 2 → "t2"
    },
    onToken: () => { /* deliberately does not feed back into anything the loop reads */ },
    getExpiresAt: () => Promise.resolve(undefined), // coarse re-check interval each cycle
    initialToken: "t0",
    initialExpiresAt: undefined,
    skewMs: 1000,
    now: () => 0,
    setTimer: (fn) => { timers.push(fn); return timers.length - 1; },
    clearTimer: () => {},
  });

  // eslint-disable-next-line @typescript-eslint/await-thenable
  await timers[0]!(); // cycle 1: refresh(t0) → t1
  // eslint-disable-next-line @typescript-eslint/await-thenable
  await timers[1]!(); // cycle 2: refresh must use t1, NOT the frozen t0

  expect(calledWith).toEqual(["t0", "t1"]);
  stop();
});

test("startTokenRefreshLoop swallows a refresh that returns null and re-arms", async () => {
  const nowMs = 0;
  const timers: Array<() => void> = [];
  const stop = startTokenRefreshLoop({
    refresh: () => Promise.resolve(null),
    onToken: () => { throw new Error("should not be called on null"); },
    getExpiresAt: () => Promise.resolve(undefined),
    initialToken: "t",
    initialExpiresAt: undefined,
    skewMs: 1000,
    now: () => nowMs,
    setTimer: (fn) => { timers.push(fn); return timers.length - 1; },
    clearTimer: () => {},
  });
  // eslint-disable-next-line @typescript-eslint/await-thenable
  await timers[0]!();          // refresh → null → onToken NOT called, must re-arm
  expect(timers.length).toBe(2);
  stop();
});

test("startTokenRefreshLoop backs off to skewMs on a transient (null) refresh instead of busy-spinning", async () => {
  // Guards against re-reading an UNCHANGED near-expiry on a null (transient)
  // refresh: onExpiry never ran, so getExpiresAt() still returns the same
  // near expiry that made the timer fire in the first place. If the loop
  // re-read it anyway, nextRefreshDelayMs would come back ~0 again and the
  // loop would re-fire immediately, busy-spinning the token endpoint for the
  // whole duration of the transient failure. It must instead back off to the
  // coarse skewMs re-check, exactly like the thrown-error path already does.
  const nowMs = 0;
  const nearExpiry = new Date(nowMs + 60_000).toISOString(); // 60s out
  const skewMs = 120_000; // within skew → due immediately (delay 0)
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const stop = startTokenRefreshLoop({
    refresh: () => Promise.resolve(null), // transient failure: network/5xx/429/timeout
    onToken: () => { throw new Error("should not be called on null"); },
    getExpiresAt: () => Promise.resolve(nearExpiry), // unchanged: onExpiry never ran
    initialToken: "t",
    initialExpiresAt: nearExpiry,
    skewMs,
    now: () => nowMs,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimer: () => {},
  });

  expect(timers.length).toBe(1);
  expect(timers[0]!.ms).toBe(0); // due immediately, per the near expiry
  // eslint-disable-next-line @typescript-eslint/await-thenable
  await timers[0]!.fn();
  expect(timers.length).toBe(2);
  expect(timers[1]!.ms).toBe(skewMs); // backed off, NOT re-armed at ~0 again
  stop();
});

test("startTokenRefreshLoop swallows a thrown refresh (e.g. ReauthRequiredError) and re-arms", async () => {
  const nowMs = 0;
  const timers: Array<() => void> = [];
  let onTokenCalled = false;
  const stop = startTokenRefreshLoop({
    refresh: () => { throw new Error("ReauthRequiredError: re-login required"); },
    onToken: () => { onTokenCalled = true; },
    getExpiresAt: () => Promise.resolve(undefined),
    initialToken: "t",
    initialExpiresAt: undefined,
    skewMs: 1000,
    now: () => nowMs,
    setTimer: (fn) => { timers.push(fn); return timers.length - 1; },
    clearTimer: () => {},
  });
  // eslint-disable-next-line @typescript-eslint/await-thenable
  await timers[0]!();          // refresh throws → swallowed, onToken NOT called, must re-arm
  expect(onTokenCalled).toBe(false);
  expect(timers.length).toBe(2);
  stop();
});
