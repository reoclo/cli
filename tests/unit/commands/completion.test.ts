// tests/unit/commands/completion.test.ts
import { expect, test, describe } from "bun:test";
import { Command } from "commander";
import { registerCompletion } from "../../../src/commands/completion";

function captureCompletion(shell: string): {
  stdout: string;
  stderr: string;
  exitCode: number | null;
} {
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;

  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: unknown): boolean => {
    stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  process.stderr.write = (chunk: unknown): boolean => {
    stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };

  try {
    const program = new Command().exitOverride();
    registerCompletion(program);
    program.parse(["node", "reoclo", "completion", shell]);
  } catch (e) {
    const err = e as { exitCode?: number; code?: string };
    exitCode = err.exitCode ?? (err.code ? 2 : 1);
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }

  return { stdout, stderr, exitCode };
}

describe("reoclo completion", () => {
  test("emits a bash completion script that wires _reoclo", () => {
    const { stdout } = captureCompletion("bash");
    expect(stdout).toContain("_reoclo()");
    expect(stdout).toContain("complete -F _reoclo reoclo");
    expect(stdout).toContain("apps");
    expect(stdout).toContain("servers");
  });

  test("emits a zsh completion script with #compdef", () => {
    const { stdout } = captureCompletion("zsh");
    expect(stdout.startsWith("#compdef reoclo")).toBe(true);
    expect(stdout).toContain("compdef _reoclo reoclo");
  });

  test("emits a fish completion script", () => {
    const { stdout } = captureCompletion("fish");
    expect(stdout).toContain("complete -c reoclo");
    expect(stdout).toContain("__fish_seen_subcommand_from servers");
  });

  test("rejects unsupported shell with exit code 2", () => {
    const { stderr, exitCode } = captureCompletion("powershell");
    expect(stderr).toContain("unsupported shell: powershell");
    expect(exitCode).toBe(2);
  });
});
