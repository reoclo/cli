import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import {
  requireCapability,
  getRequiredCapability,
  ensureCapabilityOrExit,
} from "../../src/client/command-meta";

describe("requireCapability", () => {
  test("attaches capability metadata to a command", () => {
    const cmd = new Command("test");
    requireCapability(cmd, "container:exec");
    expect(getRequiredCapability(cmd)).toBe("container:exec");
  });

  test("returns null when no capability is set", () => {
    const cmd = new Command("plain");
    expect(getRequiredCapability(cmd)).toBeNull();
  });
});

describe("ensureCapabilityOrExit", () => {
  test("does nothing when capability is granted", () => {
    expect(() =>
      ensureCapabilityOrExit(["container:exec"], "container:exec"),
    ).not.toThrow();
  });

  test("throws an exit-coded error when capability is missing", () => {
    try {
      ensureCapabilityOrExit(["container:read"], "container:exec");
      throw new Error("did not throw");
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      expect(e.exitCode).toBe(13);
      expect(e.message).toContain("container:exec");
    }
  });

  test("throws when capability list is undefined", () => {
    try {
      ensureCapabilityOrExit(undefined, "container:exec");
      throw new Error("did not throw");
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      expect(e.exitCode).toBe(13);
    }
  });
});
