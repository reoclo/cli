import { describe, expect, test } from "bun:test";
import { buildShellWrappedCommand, parseEnvFile } from "../../../src/commands/exec";

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

describe("parseEnvFile", () => {
  test("parses simple KEY=VAL lines", () => {
    const out = parseEnvFile("FOO=1\nBAR=hello\n", "test.env");
    expect(out).toEqual({ FOO: "1", BAR: "hello" });
  });

  test("ignores blank lines and # comments", () => {
    const out = parseEnvFile("# a comment\n\nFOO=1\n  # indented comment\nBAR=2\n", "x");
    expect(out).toEqual({ FOO: "1", BAR: "2" });
  });

  test("strips matching single or double quotes from values", () => {
    const out = parseEnvFile(`A='quoted'\nB="also"\nC=plain\n`, "x");
    expect(out).toEqual({ A: "quoted", B: "also", C: "plain" });
  });

  test("preserves literal quotes that are not on both ends", () => {
    const out = parseEnvFile(`A='mismatched\nB=mid"quote"value\n`, "x");
    expect(out.A).toBe("'mismatched");
    expect(out.B).toBe('mid"quote"value');
  });

  test("rejects lines without an '=' with the line number", () => {
    expect(() => parseEnvFile("FOO=1\nNOTAVAR\nBAR=2\n", "my.env")).toThrow(
      /my\.env.*line 2.*NOTAVAR/i,
    );
  });

  test("rejects invalid key shapes", () => {
    expect(() => parseEnvFile("1FOO=bar\n", "my.env")).toThrow(/invalid key/i);
    expect(() => parseEnvFile("FOO-BAR=baz\n", "my.env")).toThrow(/invalid key/i);
  });

  test("does not expand variables", () => {
    const out = parseEnvFile("FOO=$HOME\n", "x");
    expect(out.FOO).toBe("$HOME");
  });

  test("accepts a trailing newline-less file", () => {
    expect(parseEnvFile("FOO=1", "x")).toEqual({ FOO: "1" });
  });
});
