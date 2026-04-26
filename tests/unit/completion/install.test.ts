// tests/unit/completion/install.test.ts
import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { Command } from "commander";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getInstallTarget,
  registerCompletion,
} from "../../../src/commands/completion";

let tmpHome: string;
let originalHome: string | undefined;
let stdout = "";
let restoreOut: (() => void) | undefined;

function captureStdio(): void {
  stdout = "";
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: unknown): boolean => {
    stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  // Swallow stderr so failed installs don't pollute test output.
  process.stderr.write = (_chunk: unknown): boolean => true;
  restoreOut = (): void => {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  };
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "reoclo-install-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (restoreOut) restoreOut();
  restoreOut = undefined;
  if (originalHome !== undefined) {
    process.env.HOME = originalHome;
  } else {
    delete process.env.HOME;
  }
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

async function runCli(args: string[]): Promise<number> {
  const program = new Command().exitOverride();
  registerCompletion(program);
  try {
    await program.parseAsync(["node", "reoclo", ...args]);
    return 0;
  } catch (e) {
    const err = e as { exitCode?: number };
    return err.exitCode ?? 1;
  }
}

describe("getInstallTarget", () => {
  test("bash target points at ~/.reoclo-completion.bash and ~/.bashrc", () => {
    const t = getInstallTarget("bash", "/home/u");
    expect(t.scriptPath).toBe("/home/u/.reoclo-completion.bash");
    expect(t.rcPath).toBe("/home/u/.bashrc");
    expect(t.rcLine).toContain(".reoclo-completion.bash");
  });

  test("zsh target points at ~/.zfunc/_reoclo and ~/.zshrc", () => {
    const t = getInstallTarget("zsh", "/home/u");
    expect(t.scriptPath).toBe("/home/u/.zfunc/_reoclo");
    expect(t.rcPath).toBe("/home/u/.zshrc");
    expect(t.rcLine).toContain("fpath");
    expect(t.rcLine).toContain(".zfunc");
  });

  test("fish target points at ~/.config/fish/completions/reoclo.fish (no rc edit)", () => {
    const t = getInstallTarget("fish", "/home/u");
    expect(t.scriptPath).toBe("/home/u/.config/fish/completions/reoclo.fish");
    expect(t.rcPath).toBeUndefined();
  });
});

describe("completion install --print", () => {
  test("--shell bash --print prints script + rc line, writes nothing", async () => {
    captureStdio();
    const code = await runCli(["completion", "install", "--shell", "bash", "--print"]);
    expect(code).toBe(0);
    expect(stdout).toContain(`would write to: ${join(tmpHome, ".reoclo-completion.bash")}`);
    expect(stdout).toContain("complete -F _reoclo reoclo");
    expect(stdout).toContain(".bashrc");
    expect(existsSync(join(tmpHome, ".reoclo-completion.bash"))).toBe(false);
  });

  test("--shell zsh --print prints zsh-specific layout", async () => {
    captureStdio();
    const code = await runCli(["completion", "install", "--shell", "zsh", "--print"]);
    expect(code).toBe(0);
    expect(stdout).toContain(join(tmpHome, ".zfunc", "_reoclo"));
    expect(stdout).toContain("compdef _reoclo reoclo");
    expect(stdout).toContain("fpath");
    expect(existsSync(join(tmpHome, ".zfunc", "_reoclo"))).toBe(false);
  });
});

describe("completion install (writes)", () => {
  test("bash: writes the script + appends source line if missing", async () => {
    captureStdio();
    const code = await runCli(["completion", "install", "--shell", "bash", "--force"]);
    expect(code).toBe(0);
    const scriptPath = join(tmpHome, ".reoclo-completion.bash");
    const rcPath = join(tmpHome, ".bashrc");
    expect(existsSync(scriptPath)).toBe(true);
    expect(readFileSync(scriptPath, "utf8")).toContain("complete -F _reoclo reoclo");
    expect(existsSync(rcPath)).toBe(true);
    expect(readFileSync(rcPath, "utf8")).toContain(".reoclo-completion.bash");
  });

  test("bash: idempotent — running twice doesn't double the source line", async () => {
    captureStdio();
    await runCli(["completion", "install", "--shell", "bash", "--force"]);
    await runCli(["completion", "install", "--shell", "bash", "--force"]);
    const rc = readFileSync(join(tmpHome, ".bashrc"), "utf8");
    const matches = rc.split(".reoclo-completion.bash").length - 1;
    // The string ".reoclo-completion.bash" appears exactly twice in the
    // rc-line (once in the test and once in the source path), so two
    // occurrences = single line; four would mean we appended twice.
    expect(matches).toBe(2);
  });

  test("zsh: writes to ~/.zfunc/_reoclo and adds fpath line", async () => {
    captureStdio();
    const code = await runCli(["completion", "install", "--shell", "zsh", "--force"]);
    expect(code).toBe(0);
    const scriptPath = join(tmpHome, ".zfunc", "_reoclo");
    expect(existsSync(scriptPath)).toBe(true);
    expect(readFileSync(scriptPath, "utf8")).toContain("compdef _reoclo reoclo");
    const rc = readFileSync(join(tmpHome, ".zshrc"), "utf8");
    expect(rc).toContain("fpath=");
    expect(rc).toContain(".zfunc");
  });

  test("fish: writes to ~/.config/fish/completions/reoclo.fish (no rc edit)", async () => {
    captureStdio();
    const code = await runCli(["completion", "install", "--shell", "fish", "--force"]);
    expect(code).toBe(0);
    const scriptPath = join(tmpHome, ".config", "fish", "completions", "reoclo.fish");
    expect(existsSync(scriptPath)).toBe(true);
    expect(readFileSync(scriptPath, "utf8")).toContain("complete -c reoclo");
    // No fish rc file is touched.
    expect(existsSync(join(tmpHome, ".config", "fish", "config.fish"))).toBe(false);
  });

  test("--force overwrites an existing different file without prompting", async () => {
    const scriptPath = join(tmpHome, ".reoclo-completion.bash");
    writeFileSync(scriptPath, "# old bogus content\n", "utf8");
    captureStdio();
    const code = await runCli(["completion", "install", "--shell", "bash", "--force"]);
    expect(code).toBe(0);
    expect(readFileSync(scriptPath, "utf8")).toContain("_reoclo()");
  });
});
