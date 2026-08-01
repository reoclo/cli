import { test, expect } from "bun:test";
import { needsProactiveRefresh, nextRefreshDelayMs, PROACTIVE_SKEW_MS } from "../../../src/auth/proactive";

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
