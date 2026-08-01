import { test, expect } from "bun:test";
import { startTokenRefreshLoop } from "../../../src/auth/proactive";

test("startTokenRefreshLoop refreshes at expiry-skew and re-arms from the new expiry", async () => {
  const t0 = Date.parse("2026-08-01T12:00:00.000Z");
  const nowMs = t0;
  const timers: Array<{ fn: () => void; at: number }> = [];
  let tok = "tok-0";
  const expiries = ["2026-08-01T12:10:00.000Z", "2026-08-01T13:10:00.000Z"]; // after each refresh
  let refreshCount = 0;

  const stop = startTokenRefreshLoop({
    refresh: () => { tok = `tok-${++refreshCount}`; return Promise.resolve(tok); },
    currentToken: () => tok,
    onToken: (t) => { tok = t; },
    // Indexed by "which refresh cycle this is" (0-based): getExpiresAt is
    // always called right after refresh() increments refreshCount, so
    // refreshCount - 1 is the completed cycle whose post-refresh expiry we want.
    getExpiresAt: () =>
      Promise.resolve(expiries[Math.min(Math.max(0, refreshCount - 1), expiries.length - 1)]),
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
  expect(tok).toBe("tok-1");
  // Re-armed from new expiry 12:10 → delay 12:10 - skew - now(12:00) = 8m.
  expect(timers.length).toBe(2);
  expect(timers[1]!.at - t0).toBe(8 * 60_000);
  stop();
});

test("startTokenRefreshLoop swallows a refresh that returns null and re-arms", async () => {
  const nowMs = 0;
  const timers: Array<() => void> = [];
  const stop = startTokenRefreshLoop({
    refresh: () => Promise.resolve(null),
    currentToken: () => "t",
    onToken: () => { throw new Error("should not be called on null"); },
    getExpiresAt: () => Promise.resolve(undefined),
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
