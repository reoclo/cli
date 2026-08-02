import { test, expect } from "bun:test";
import {
  needsProactiveRefresh,
  nextRefreshDelayMs,
  applyProactiveRefresh,
  PROACTIVE_SKEW_MS,
} from "../../../src/auth/proactive";

const t0 = Date.parse("2026-08-01T12:00:00.000Z");
const iso = (ms: number) => new Date(t0 + ms).toISOString();

test("needsProactiveRefresh: missing/unparseable expiry → false (rely on reactive)", () => {
  expect(needsProactiveRefresh(undefined, t0, PROACTIVE_SKEW_MS)).toBe(false);
  expect(needsProactiveRefresh("not-a-date", t0, PROACTIVE_SKEW_MS)).toBe(false);
});

test("needsProactiveRefresh: within skew of expiry → true", () => {
  expect(needsProactiveRefresh(iso(60_000), t0, PROACTIVE_SKEW_MS)).toBe(true);   // 60s left < 120s skew
  expect(needsProactiveRefresh(iso(-5_000), t0, PROACTIVE_SKEW_MS)).toBe(true);   // already expired
});

test("needsProactiveRefresh: comfortably before expiry → false", () => {
  expect(needsProactiveRefresh(iso(600_000), t0, PROACTIVE_SKEW_MS)).toBe(false); // 10m left
});

test("nextRefreshDelayMs: schedules at expiry - skew, clamped to >= 0", () => {
  expect(nextRefreshDelayMs(iso(600_000), t0, PROACTIVE_SKEW_MS)).toBe(600_000 - PROACTIVE_SKEW_MS);
  expect(nextRefreshDelayMs(iso(60_000), t0, PROACTIVE_SKEW_MS)).toBe(0); // already within skew → due now
});

test("nextRefreshDelayMs: missing expiry → large sentinel (check again later, never negative)", () => {
  const d = nextRefreshDelayMs(undefined, t0, PROACTIVE_SKEW_MS);
  expect(d).toBeGreaterThan(0);
});

test("applyProactiveRefresh: due + refresh succeeds → returns the fresh token, calls refresh once", async () => {
  let calls = 0;
  const refresh = (currentToken: string): Promise<string | null> => {
    calls += 1;
    expect(currentToken).toBe("stale-token");
    return Promise.resolve("fresh-token");
  };
  const result = await applyProactiveRefresh(
    "stale-token",
    iso(-5_000), // already expired
    refresh,
    t0,
    PROACTIVE_SKEW_MS,
  );
  expect(result).toBe("fresh-token");
  expect(calls).toBe(1);
});

test("applyProactiveRefresh: due + refresh returns null (transient) → returns the ORIGINAL token", async () => {
  const refresh = (): Promise<string | null> => Promise.resolve(null);
  const result = await applyProactiveRefresh(
    "stale-token",
    iso(-5_000),
    refresh,
    t0,
    PROACTIVE_SKEW_MS,
  );
  expect(result).toBe("stale-token");
});

test("applyProactiveRefresh: not due (comfortably before expiry) → refresh is never called", async () => {
  let calls = 0;
  const refresh = (): Promise<string | null> => {
    calls += 1;
    return Promise.resolve("fresh-token");
  };
  const result = await applyProactiveRefresh(
    "stale-token",
    iso(600_000), // 10m left, well outside skew
    refresh,
    t0,
    PROACTIVE_SKEW_MS,
  );
  expect(result).toBe("stale-token");
  expect(calls).toBe(0);
});

test("applyProactiveRefresh: refresh callback undefined → returns the original token", async () => {
  const result = await applyProactiveRefresh(
    "stale-token",
    iso(-5_000), // would be due, but there's nothing to refresh with
    undefined,
    t0,
    PROACTIVE_SKEW_MS,
  );
  expect(result).toBe("stale-token");
});
