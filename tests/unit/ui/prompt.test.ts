import { describe, expect, test } from "bun:test";
import { parseChoice } from "../../../src/ui/prompt";

describe("parseChoice", () => {
  test("an empty answer uses the default", () => {
    expect(parseChoice("", 3, 0)).toBe(0);
    expect(parseChoice("   ", 3, 2)).toBe(2);
  });

  test("a valid 1-based number maps to a 0-based index", () => {
    expect(parseChoice("1", 3, 0)).toBe(0);
    expect(parseChoice("2", 3, 0)).toBe(1);
    expect(parseChoice("3", 3, 0)).toBe(2);
  });

  test("out-of-range numbers fall back to the default", () => {
    expect(parseChoice("0", 3, 1)).toBe(1);
    expect(parseChoice("4", 3, 1)).toBe(1);
  });

  test("non-numeric input falls back to the default", () => {
    expect(parseChoice("abc", 3, 2)).toBe(2);
  });
});
