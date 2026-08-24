import { describe, expect, test } from "bun:test";
import { parseBool, parseEnum, parseIntFlag } from "../../../src/util/parse-flag";

function exitCodeOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { exitCode?: number }).exitCode;
  }
  return undefined;
}

describe("parseBool", () => {
  test("accepts the spellings a caller is likely to type", () => {
    for (const v of ["true", "TRUE", "yes", "y", "1", "on", " true "]) {
      expect(parseBool(v, "--visible")).toBe(true);
    }
    for (const v of ["false", "FALSE", "no", "n", "0", "off"]) {
      expect(parseBool(v, "--visible")).toBe(false);
    }
  });

  test("rejects anything else with exit code 2 and names the flag", () => {
    expect(exitCodeOf(() => parseBool("maybe", "--visible"))).toBe(2);
    expect(() => parseBool("maybe", "--visible")).toThrow(/--visible.*'maybe'/);
  });
});

describe("parseEnum", () => {
  const allowed = ["domain", "server", "manual"] as const;

  test("accepts an allowed value, normalising case", () => {
    expect(parseEnum("Server", allowed, "--source")).toBe("server");
  });

  test("lists the allowed values when the input is wrong", () => {
    expect(() => parseEnum("app", allowed, "--source")).toThrow(/domain, server, manual/);
    expect(exitCodeOf(() => parseEnum("app", allowed, "--source"))).toBe(2);
  });
});

describe("parseIntFlag", () => {
  test("accepts integers inside the range, including the bounds", () => {
    expect(parseIntFlag("10", "--health-interval", 10, 3600)).toBe(10);
    expect(parseIntFlag("3600", "--health-interval", 10, 3600)).toBe(3600);
  });

  test("rejects out-of-range, fractional, and non-numeric values", () => {
    for (const v of ["9", "3601", "1.5", "abc", ""]) {
      expect(exitCodeOf(() => parseIntFlag(v, "--health-interval", 10, 3600))).toBe(2);
    }
  });
});
