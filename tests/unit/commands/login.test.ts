// tests/unit/commands/login.test.ts
//
// Regression test for the global-vs-local `--profile` collision: `--profile` is
// declared as a ROOT-level (global) option in index.ts. `reoclo login` must
// read it via optsWithGlobals(), NOT re-declare a command-local `--profile`
// (whose default would shadow the global value — commander routes the typed
// value to the global option and leaves the local one at its default, so
// `login --profile staging` silently logged into / overwrote `default`).
//
// We inject the device-flow runner so the test never touches the network,
// keyring, or config — it asserts only which profile the command resolves.

import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerLogin, type LoginFlowOptions } from "../../../src/commands/login";

function buildProgram(captured: { opts?: LoginFlowOptions }): Command {
  const program = new Command();
  program.name("reoclo").exitOverride();
  // Mirror index.ts: --profile is a GLOBAL (root-level) flag.
  program.option("--profile <name>", "use a named profile");
  registerLogin(program, (opts) => {
    captured.opts = opts;
    return Promise.resolve();
  });
  return program;
}

function withoutEnvProfile<T>(fn: () => T): T {
  const saved = process.env.REOCLO_PROFILE;
  delete process.env.REOCLO_PROFILE;
  try {
    return fn();
  } finally {
    if (saved !== undefined) process.env.REOCLO_PROFILE = saved;
  }
}

describe("login honors the global --profile flag", () => {
  test("`login --profile staging` targets staging with source 'flag'", async () => {
    const captured: { opts?: LoginFlowOptions } = {};
    await withoutEnvProfile(() =>
      buildProgram(captured).parseAsync(["node", "reoclo", "login", "--profile", "staging"]),
    );
    expect(captured.opts?.profile).toBe("staging");
    expect(captured.opts?.source).toBe("flag");
  });

  test("`login --profile=prod` targets prod with source 'flag'", async () => {
    const captured: { opts?: LoginFlowOptions } = {};
    await withoutEnvProfile(() =>
      buildProgram(captured).parseAsync(["node", "reoclo", "login", "--profile=prod"]),
    );
    expect(captured.opts?.profile).toBe("prod");
    expect(captured.opts?.source).toBe("flag");
  });

  test("bare `login` defaults to 'default' with source 'default'", async () => {
    const captured: { opts?: LoginFlowOptions } = {};
    await withoutEnvProfile(() =>
      buildProgram(captured).parseAsync(["node", "reoclo", "login"]),
    );
    expect(captured.opts?.profile).toBe("default");
    expect(captured.opts?.source).toBe("default");
  });

  test("`login` honors $REOCLO_PROFILE with source 'env'", async () => {
    const captured: { opts?: LoginFlowOptions } = {};
    const saved = process.env.REOCLO_PROFILE;
    process.env.REOCLO_PROFILE = "work";
    try {
      await buildProgram(captured).parseAsync(["node", "reoclo", "login"]);
    } finally {
      if (saved === undefined) delete process.env.REOCLO_PROFILE;
      else process.env.REOCLO_PROFILE = saved;
    }
    expect(captured.opts?.profile).toBe("work");
    expect(captured.opts?.source).toBe("env");
  });

  test("login declares no command-local --profile option (it is global)", () => {
    const program = new Command();
    program.option("--profile <name>", "global");
    registerLogin(program, () => Promise.resolve());
    const login = program.commands.find((c) => c.name() === "login");
    expect(login).toBeDefined();
    expect(login?.options.some((o) => o.long === "--profile")).toBe(false);
  });
});
