import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import {
  requireCapability,
  getRequiredCapability,
  ensureCapabilityOrExit,
  withCompletion,
  getCompletionSpec,
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

  test("treats an undefined capability list as 'unknown — allow through'", () => {
    // Pairs with filterCommandsByCapability — when the local cap cache hasn't
    // been populated we let the server enforce instead of locking the user out.
    expect(() => ensureCapabilityOrExit(undefined, "container:exec")).not.toThrow();
  });

  test("treats an empty capability list as 'unknown — allow through'", () => {
    expect(() => ensureCapabilityOrExit([], "container:exec")).not.toThrow();
  });
});

describe("withCompletion", () => {
  test("attaches and reads a completion spec", () => {
    const cmd = new Command("get");
    withCompletion(cmd, { args: [{ slot: 0, resource: "servers" }] });
    expect(getCompletionSpec(cmd)).toEqual({ args: [{ slot: 0, resource: "servers" }] });
  });

  test("returns null when no spec is set", () => {
    expect(getCompletionSpec(new Command("plain"))).toBeNull();
  });

  test("reads back a spec with both args and flags", () => {
    const cmd = new Command("deploy");
    const spec = {
      args: [{ slot: 0, resource: "apps" as const }],
      flags: { "--source": { enum: ["a", "b"] } },
    };
    withCompletion(cmd, spec);
    expect(getCompletionSpec(cmd)).toEqual(spec);
  });
});
