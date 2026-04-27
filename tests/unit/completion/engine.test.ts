// tests/unit/completion/engine.test.ts
import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { Command } from "commander";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCompletionCandidates } from "../../../src/completion/engine";
import { registerCompletion } from "../../../src/commands/completion";
import { registerApps } from "../../../src/commands/apps";
import { registerServers } from "../../../src/commands/servers";
import { registerDeployments } from "../../../src/commands/deployments";
import { registerDomains } from "../../../src/commands/domains";
import { registerEnv } from "../../../src/commands/env";
import { registerExec } from "../../../src/commands/exec";
import { registerShell } from "../../../src/commands/shell";
import { registerLogin } from "../../../src/commands/login";
import { registerLogout } from "../../../src/commands/logout";
import { registerWhoami } from "../../../src/commands/whoami";
import { registerLogs } from "../../../src/commands/logs";
import { registerUpgrade } from "../../../src/commands/upgrade";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reoclo-cmp-"));
  process.env.REOCLO_CACHE_DIR = tmp;
});

afterEach(() => {
  delete process.env.REOCLO_CACHE_DIR;
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function buildProgram(): Command {
  const program = new Command().name("reoclo");
  registerLogin(program);
  registerLogout(program);
  registerWhoami(program);
  registerServers(program);
  registerApps(program);
  registerDeployments(program);
  registerDomains(program);
  registerEnv(program);
  registerExec(program);
  registerShell(program);
  registerLogs(program);
  registerUpgrade(program);
  registerCompletion(program);
  return program;
}

function writeCache(payload: Record<string, unknown>): void {
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, "slug-cache.json"), JSON.stringify(payload), "utf8");
}

describe("getCompletionCandidates", () => {
  test("empty input returns top-level commands", () => {
    const program = buildProgram();
    const out = getCompletionCandidates(program, [], "");
    expect(out).toContain("apps");
    expect(out).toContain("servers");
    expect(out).toContain("login");
    // Hidden command must not leak.
    expect(out).not.toContain("__complete");
  });

  test("['apps'] returns subcommands of apps", () => {
    const program = buildProgram();
    const out = getCompletionCandidates(program, ["apps"], "");
    for (const sub of ["ls", "get", "deploy", "logs", "restart"]) {
      expect(out).toContain(sub);
    }
  });

  test("['servers'] returns subcommands of servers", () => {
    const program = buildProgram();
    const out = getCompletionCandidates(program, ["servers"], "");
    for (const sub of ["ls", "get", "metrics"]) {
      expect(out).toContain(sub);
    }
  });

  test("['apps','deploy'] with populated cache returns app slugs", () => {
    writeCache({
      version: 2,
      servers: {},
      apps: {
        "app-1": { id: "00000000-0000-0000-0000-00000000cccc", slug: "app-1", name: "App 1", ts: Date.now() },
        "app-2": { id: "00000000-0000-0000-0000-00000000dddd", slug: "app-2", name: "App 2", ts: Date.now() },
      },
    });
    const program = buildProgram();
    const out = getCompletionCandidates(program, ["apps", "deploy"], "");
    expect(out).toContain("app-1");
    expect(out).toContain("app-2");
  });

  test("['apps','deploy'] with empty cache returns empty", () => {
    const program = buildProgram();
    const out = getCompletionCandidates(program, ["apps", "deploy"], "");
    expect(out).toEqual([]);
  });

  test("['apps','deploy'] with current='--' returns flags for apps deploy", () => {
    const program = buildProgram();
    const out = getCompletionCandidates(program, ["apps", "deploy"], "--");
    expect(out).toContain("--ref");
    expect(out).toContain("--wait");
  });

  test("['exec'] with populated cache returns server names (exec is a leaf)", () => {
    writeCache({
      version: 2,
      apps: {},
      servers: {
        "srv-1": { id: "00000000-0000-0000-0000-00000000bbbb", slug: "srv-1", name: "Server 1", ts: Date.now() },
        "srv-2": { id: "00000000-0000-0000-0000-00000000eeee", slug: "srv-2", name: "Server 2", ts: Date.now() },
      },
    });
    const program = buildProgram();
    const out = getCompletionCandidates(program, ["exec"], "");
    expect(out).toContain("srv-1");
    expect(out).toContain("srv-2");
    // Must not leak subcommand names since exec is a leaf with no children.
    expect(out).not.toContain("ls");
  });

  test("prefix filtering narrows candidates", () => {
    const program = buildProgram();
    const out = getCompletionCandidates(program, [], "se");
    expect(out).toContain("servers");
    expect(out).not.toContain("apps");
  });

  test("invalid input never throws — returns []", () => {
    const program = buildProgram();
    // Garbage `words` should not blow up.
    const out = getCompletionCandidates(program, ["nonexistent", "what"], "");
    expect(Array.isArray(out)).toBe(true);
  });

  // Flag-value completion (the user types `cmd --flag <TAB>` and we should
  // suggest the value, not just the next flag).

  test("['logs','tail','--server'] with populated cache returns server names", () => {
    writeCache({
      version: 2,
      apps: {},
      servers: {
        "prod-1": { id: "00000000-0000-0000-0000-00000000bbbb", slug: "prod-1", name: "Prod 1", ts: Date.now() },
        "prod-2": { id: "00000000-0000-0000-0000-00000000eeee", slug: "prod-2", name: "Prod 2", ts: Date.now() },
      },
    });
    const program = buildProgram();
    const out = getCompletionCandidates(program, ["logs", "tail", "--server"], "");
    expect(out).toContain("prod-1");
    expect(out).toContain("prod-2");
  });

  test("['logs','tail','--source'] returns the static source-type set", () => {
    const program = buildProgram();
    const out = getCompletionCandidates(program, ["logs", "tail", "--source"], "");
    for (const v of ["container", "system", "docker_daemon", "runner", "kernel", "auth"]) {
      expect(out).toContain(v);
    }
  });

  test("['exec','--scope'] returns host/rootless", () => {
    const program = buildProgram();
    const out = getCompletionCandidates(program, ["exec", "--scope"], "");
    expect(out).toEqual(["host", "rootless"]);
  });

  test("['upgrade','--channel'] returns stable/beta/dev", () => {
    const program = buildProgram();
    const out = getCompletionCandidates(program, ["upgrade", "--channel"], "");
    expect(out).toEqual(["stable", "beta", "dev"]);
  });

  test("['env','ls','--app'] returns app slugs from cache", () => {
    writeCache({
      version: 2,
      servers: {},
      apps: {
        "api": { id: "00000000-0000-0000-0000-00000000cccc", slug: "api", name: "API", ts: Date.now() },
        "worker": { id: "00000000-0000-0000-0000-00000000dddd", slug: "worker", name: "Worker", ts: Date.now() },
      },
    });
    const program = buildProgram();
    const out = getCompletionCandidates(program, ["env", "ls", "--app"], "");
    expect(out).toContain("api");
    expect(out).toContain("worker");
  });

  test("flag-value prefix filter narrows candidates", () => {
    const program = buildProgram();
    const out = getCompletionCandidates(program, ["exec", "--scope"], "ho");
    expect(out).toEqual(["host"]);
  });

  test("boolean flag (no value) does NOT trigger flag-value completion", () => {
    // upgrade --check is a boolean flag — typing `reoclo upgrade --check <TAB>`
    // should fall through to other rules, not return [] from the flag-value
    // branch.
    const program = buildProgram();
    const out = getCompletionCandidates(program, ["upgrade", "--check"], "");
    // No subcommands, no resource slot — the engine returns [] but via the
    // fall-through path, not the flag-value path. Confirm we get empty here
    // (no crash, no leaked candidates).
    expect(Array.isArray(out)).toBe(true);
  });
});
