import { describe, expect, test } from "bun:test";
import { confirmAction, parseChoice } from "../../../src/ui/prompt";
import { noInputReason } from "../../../src/ui/tty";

describe("noInputReason", () => {
  test("a terminal with no agent or CI around can be asked", () => {
    expect(noInputReason({}, true)).toBeNull();
  });

  test("a coding agent's pseudo-terminal, CI or REOCLO_NO_INPUT cannot", () => {
    expect(noInputReason({ CLAUDECODE: "1" }, true)).toBe("a coding agent runs this command (CLAUDECODE is set)");
    expect(noInputReason({ PI_CODING_AGENT: "true" }, true)).toContain("PI_CODING_AGENT");
    expect(noInputReason({ AI_AGENT: "claude-code_2-1-312_agent" }, true)).toContain("AI_AGENT");
    expect(noInputReason({ CI: "true" }, true)).toBe("CI is set");
    expect(noInputReason({ REOCLO_NO_INPUT: "1" }, true)).toBe("REOCLO_NO_INPUT is set");
    expect(noInputReason({}, false)).toBe("stdin is not a terminal");
  });

  test("falsy values do not count", () => {
    expect(noInputReason({ CI: "false", AI_AGENT: "0", REOCLO_NO_INPUT: "", CLAUDECODE: "off" }, true)).toBeNull();
  });
});

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

  test("on a terminal nobody answers (REOCLO_NO_INPUT) it declines instead of waiting", async () => {
    const previous = process.env["REOCLO_NO_INPUT"];
    process.env["REOCLO_NO_INPUT"] = "1";
    try {
      expect(await withStdinTty(true, () => confirmAction("enable tests? ", false))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["REOCLO_NO_INPUT"];
      else process.env["REOCLO_NO_INPUT"] = previous;
    }
  });
});
