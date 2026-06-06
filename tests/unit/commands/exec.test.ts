import { describe, expect, test } from "bun:test";
import { buildShellWrappedCommand, parseEnvFile, maskOutput, MASK_MIN_LENGTH, detectShCQuotingFootgun, registerExec, buildAutomationExecBody, buildAutomationExecOutput } from "../../../src/commands/exec";
import { Command } from "commander";

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
    expect(() => buildShellWrappedCommand("zsh", ["echo", "hi"])).toThrow(
      /unsupported shell/i,
    );
  });
});

describe("parseEnvFile", () => {
  test("parses simple KEY=VAL lines", () => {
    const out = parseEnvFile("FOO=1\nBAR=hello\n", "test.env");
    expect(out).toEqual({ FOO: "1", BAR: "hello" });
  });

  test("preserves embedded '=' in values (splits on first '=' only)", () => {
    const out = parseEnvFile("URL=https://x.com/?a=b&c=d\n", "x");
    expect(out.URL).toBe("https://x.com/?a=b&c=d");
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

  test("returns an empty dict for an empty body", () => {
    expect(parseEnvFile("", "x")).toEqual({});
  });
});

describe("maskOutput", () => {
  test("replaces literal value occurrences with *** in a string", () => {
    expect(maskOutput("token=supersecretvalue here", { TOKEN: "supersecretvalue" })).toBe(
      "token=*** here",
    );
  });

  test("masks across multiple occurrences", () => {
    expect(maskOutput("abc abc abc", { A: "abc12345" })).toBe("abc abc abc");
    expect(maskOutput("abc12345 abc12345", { A: "abc12345" })).toBe("*** ***");
  });

  test("masks longer values before shorter substrings", () => {
    // If we masked "tokenABC" first, the longer "tokenABC-extra" would no
    // longer match. Both values are >= MASK_MIN_LENGTH (8).
    const out = maskOutput("tokenABC-extra and tokenABC alone", {
      A: "tokenABC-extra",
      B: "tokenABC",
    });
    expect(out).toBe("*** and *** alone");
  });

  test("does not mask values shorter than MASK_MIN_LENGTH", () => {
    expect(MASK_MIN_LENGTH).toBe(8);
    expect(maskOutput("1 1 1", { X: "1" })).toBe("1 1 1");
    expect(maskOutput("PROD here", { ENV: "PROD" })).toBe("PROD here");
  });

  test("does not crash on empty values", () => {
    expect(maskOutput("hello", { X: "" })).toBe("hello");
  });

  test("handles values containing regex metacharacters", () => {
    expect(maskOutput("found a.b*c+(d) here", { X: "a.b*c+(d)" })).toBe("found *** here");
  });

  test("returns input unchanged when env dict is empty", () => {
    expect(maskOutput("anything", {})).toBe("anything");
  });
});

describe("detectShCQuotingFootgun", () => {
  test("flags sh -c followed by 2+ extra args", () => {
    expect(detectShCQuotingFootgun(["sh", "-c", "echo", "hello"])).toBe(true);
  });

  test("flags bash -c followed by 2+ extra args", () => {
    expect(detectShCQuotingFootgun(["bash", "-c", "echo", "a", "b"])).toBe(true);
  });

  test("does not flag sh -c with exactly one script arg", () => {
    expect(detectShCQuotingFootgun(["sh", "-c", "echo hello"])).toBe(false);
  });

  test("does not flag other commands", () => {
    expect(detectShCQuotingFootgun(["docker", "ps", "-a"])).toBe(false);
    expect(detectShCQuotingFootgun(["printenv", "X", "Y"])).toBe(false);
  });

  test("does not flag empty argv", () => {
    expect(detectShCQuotingFootgun([])).toBe(false);
  });
});

function execCommand(): Command {
  const p = new Command().name("reoclo").exitOverride();
  registerExec(p);
  return p.commands.find((c) => c.name() === "exec")!;
}

describe("reoclo exec registration", () => {
  test("declares --shell, --env-file, --mask-env, --no-mask-env flags", () => {
    const e = execCommand();
    const flagNames = e.options.map((o) => o.long);
    expect(flagNames).toContain("--shell");
    expect(flagNames).toContain("--env-file");
    expect(flagNames).toContain("--mask-env");
    expect(flagNames).toContain("--no-mask-env");
  });

  test("--shell default is undefined (current join behavior)", () => {
    const e = execCommand();
    const shell = e.options.find((o) => o.long === "--shell")!;
    expect(shell.defaultValue).toBeUndefined();
  });

  test("--mask-env defaults to true (masking on by default)", () => {
    const e = execCommand();
    const maskOpt = e.options.find((o) => o.long === "--mask-env")!;
    expect(maskOpt.defaultValue).toBe(true);
  });

  test("--help output contains Examples section", () => {
    const e = execCommand();
    const help = e.helpInformation();
    expect(help).toContain("Examples:");
    expect(help).toContain("reoclo exec my-server -- docker ps");
    expect(help).toContain("--shell bash");
    expect(help).toContain("--env-file");
  });
});

describe("buildAutomationExecBody", () => {
  test("includes server_id, command, run_context and run_id; omits empty env", () => {
    const body = buildAutomationExecBody({
      serverId: "11111111-2222-3333-4444-555555555555",
      command: "docker ps",
      cwd: "/srv",
      env: {},
      timeoutSeconds: 120,
      runId: "9",
      runContext: { provider: "woodpecker", repository: "reoclo/app", workflow: "", trigger: "push", actor: "" },
    });
    expect(body.server_id).toBe("11111111-2222-3333-4444-555555555555");
    expect(body.command).toBe("docker ps");
    expect(body.working_directory).toBe("/srv");
    expect(body.timeout_seconds).toBe(120);
    expect(body.run_id).toBe("9");
    expect(body.run_context?.provider).toBe("woodpecker");
    expect("env" in body).toBe(false);
  });

  test("includes env when non-empty", () => {
    const body = buildAutomationExecBody({
      serverId: "11111111-2222-3333-4444-555555555555",
      command: "x",
      env: { A: "1" },
    });
    expect(body.env).toEqual({ A: "1" });
  });
});

describe("buildAutomationExecOutput", () => {
  test("carries operation_id and duration_ms into the JSON output (run-action parity)", () => {
    const out = buildAutomationExecOutput({
      operation_id: "op-123",
      exit_code: 0,
      stdout: "hello",
      stderr: "",
      duration_ms: 1234,
    });
    expect(out).toEqual({
      exit_code: 0,
      stdout: "hello",
      stderr: "",
      truncated: false,
      operation_id: "op-123",
      duration_ms: 1234,
    });
  });

  test("preserves a non-zero exit code", () => {
    const out = buildAutomationExecOutput({
      operation_id: "op-9",
      exit_code: 42,
      stdout: "",
      stderr: "boom",
      duration_ms: 7,
    });
    expect(out.exit_code).toBe(42);
    expect(out.operation_id).toBe("op-9");
    expect(out.duration_ms).toBe(7);
  });
});
