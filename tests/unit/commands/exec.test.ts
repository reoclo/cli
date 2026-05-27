import { describe, expect, test } from "bun:test";
import { buildShellWrappedCommand } from "../../../src/commands/exec";

describe("buildShellWrappedCommand", () => {
  test("wraps simple argv in bash -c with single quotes", () => {
    expect(buildShellWrappedCommand("bash", ["docker", "ps"])).toBe(
      "bash -c 'docker ps'",
    );
  });

  test("wraps simple argv in sh -c with single quotes", () => {
    expect(buildShellWrappedCommand("sh", ["echo", "hello world"])).toBe(
      "sh -c 'echo hello world'",
    );
  });

  test("escapes single quotes in args using the POSIX '\\'' dance", () => {
    // Input ["echo", "it's"] joins to: echo it's
    // After escape: echo it'\''s
    // Wrapped: bash -c 'echo it'\''s'
    expect(buildShellWrappedCommand("bash", ["echo", "it's"])).toBe(
      "bash -c 'echo it'\\''s'",
    );
  });

  test("handles a script containing pipes inside a single quoted arg", () => {
    expect(
      buildShellWrappedCommand("bash", ["docker exec backend env | wc -l"]),
    ).toBe("bash -c 'docker exec backend env | wc -l'");
  });

  test("rejects unsupported shells", () => {
    expect(() => buildShellWrappedCommand("zsh" as "bash", ["echo", "hi"])).toThrow(
      /unsupported shell/i,
    );
  });
});
