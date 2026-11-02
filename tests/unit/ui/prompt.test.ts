import { describe, expect, test } from "bun:test";
import { confirmAction, parseChoice } from "../../../src/ui/prompt";

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

describe("confirmAction", () => {
  function withStdinTty<T>(isTTY: boolean | undefined, fn: () => Promise<T>): Promise<T> {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
    return fn().finally(() => {
      if (original) Object.defineProperty(process.stdin, "isTTY", original);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    });
  }

  test("--yes confirms without asking", async () => {
    expect(await withStdinTty(false, () => confirmAction("delete x? ", true))).toBe(true);
  });

  test("without a TTY and without --yes it declines instead of waiting", async () => {
    expect(await withStdinTty(false, () => confirmAction("delete x? ", false))).toBe(false);
    expect(await withStdinTty(undefined, () => confirmAction("delete x? "))).toBe(false);
  });
});
