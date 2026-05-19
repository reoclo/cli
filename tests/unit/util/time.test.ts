import { describe, expect, test } from "bun:test";
import { parseTimeSpec } from "../../../src/util/time";

describe("parseTimeSpec", () => {
  test('"24h" returns a Date ~24h in the past', () => {
    const before = Date.now();
    const result = parseTimeSpec("24h");
    const ageMs = before - result.getTime();
    expect(ageMs).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
    expect(ageMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
  });

  test('"7d" returns a Date ~7d in the past', () => {
    const before = Date.now();
    const result = parseTimeSpec("7d");
    const ageMs = before - result.getTime();
    expect(ageMs).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000 - 1000);
    expect(ageMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 1000);
  });

  test('"30m" returns a Date ~30m in the past', () => {
    const before = Date.now();
    const result = parseTimeSpec("30m");
    const ageMs = before - result.getTime();
    expect(ageMs).toBeGreaterThanOrEqual(30 * 60 * 1000 - 1000);
    expect(ageMs).toBeLessThanOrEqual(30 * 60 * 1000 + 1000);
  });

  test("ISO 8601 timestamp round-trips", () => {
    const iso = "2026-05-15T10:00:00.000Z";
    expect(parseTimeSpec(iso).toISOString()).toBe(iso);
  });

  test('bare date "YYYY-MM-DD" parses', () => {
    const result = parseTimeSpec("2026-05-15");
    expect(result.getUTCFullYear()).toBe(2026);
    expect(result.getUTCMonth()).toBe(4);
    expect(result.getUTCDate()).toBe(15);
  });

  test('invalid input "abc" throws with helpful message', () => {
    expect(() => parseTimeSpec("abc")).toThrow(
      "invalid time spec: 'abc' (try '24h', '7d', or ISO 8601)",
    );
  });

  test('zero-quantity "0h" returns now', () => {
    const before = Date.now();
    const result = parseTimeSpec("0h");
    expect(Math.abs(before - result.getTime())).toBeLessThanOrEqual(1000);
  });
});
