import { describe, expect, test } from "bun:test";
import { parseLimit } from "../../../src/util/parse-limit";

describe("parseLimit", () => {
  test("valid integer round-trips", () => {
    expect(parseLimit("42", 1000)).toBe(42);
  });

  test("clamps to hardCap", () => {
    expect(parseLimit("99999", 1000)).toBe(1000);
  });

  test("rejects non-numeric with documented message", () => {
    let err: (Error & { exitCode?: number }) | undefined;
    try {
      parseLimit("abc", 1000);
    } catch (e) {
      err = e as Error & { exitCode?: number };
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain("invalid --limit");
    expect(err!.message).toContain("abc");
    expect(err!.exitCode).toBe(2);
  });

  test("rejects float", () => {
    expect(() => parseLimit("1.5", 1000)).toThrow("invalid --limit");
  });

  test("rejects zero", () => {
    expect(() => parseLimit("0", 1000)).toThrow("invalid --limit");
  });

  test("rejects negative", () => {
    expect(() => parseLimit("-1", 1000)).toThrow("invalid --limit");
  });

  test("accepts scientific notation that parses to integer", () => {
    // Number("1e2") === 100, Number.isInteger(100) === true
    expect(parseLimit("1e2", 1000)).toBe(100);
  });
});
