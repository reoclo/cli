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

  test("neutralises shell metacharacters via single-quoting", () => {
    // && would be a command separator if unquoted; single quotes make it inert.
    expect(buildShellWrappedCommand("bash", ["echo", "hello && rm -rf /"])).toBe(
      "bash -c 'echo hello && rm -rf /'",
    );
  });

  test("throws on empty argv", () => {
    expect(() => buildShellWrappedCommand("bash", [])).toThrow(/must not be empty/i);
  });

  test("rejects unsupported shells", () => {
    expect(() => buildShellWrappedCommand("zsh" as "bash", ["echo", "hi"])).toThrow(
      /unsupported shell/i,
    );
  });
});
