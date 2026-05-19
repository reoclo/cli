// tests/integration/completion.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { getCompletionCandidates } from "../../src/completion/engine";
import { writeSlice } from "../../src/completion/cache";
import { registerServers } from "../../src/commands/servers";
import { registerApps } from "../../src/commands/apps";
import { registerDeployments } from "../../src/commands/deployments";
import { registerLogs } from "../../src/commands/logs";
import { registerEnv } from "../../src/commands/env";
import { registerDomains } from "../../src/commands/domains";
import { registerUpgrade } from "../../src/commands/upgrade";
import { registerCompletion } from "../../src/commands/completion";
import { registerExec } from "../../src/commands/exec";
import { registerShell } from "../../src/commands/shell";
import { registerTunnel } from "../../src/commands/tunnel";
import { registerProfile } from "../../src/commands/profile";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reoclo-integ-"));
  process.env.REOCLO_CACHE_DIR = tmp;
});
afterEach(() => {
  delete process.env.REOCLO_CACHE_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

function buildProgram(): Command {
  const p = new Command().name("reoclo");
  registerServers(p);
  registerApps(p);
  registerDeployments(p);
  registerLogs(p);
  registerEnv(p);
  registerDomains(p);
  registerUpgrade(p);
  registerCompletion(p);
  registerExec(p);
  registerShell(p);
  registerTunnel(p);
  registerProfile(p);
  return p;
}

test("tunnel completes servers and subcommands together", () => {
  writeSlice("servers", [{ id: "1", value: "prod-web", name: "p", desc: "" }]);
  const vals = getCompletionCandidates(buildProgram(), ["tunnel"], "").map((c) => c.value);
  expect(vals).toContain("ls");
  expect(vals).toContain("prod-web");
});

test("__complete with no args emits top-level commands", async () => {
  const r = await $`bun run src/index.ts __complete -- ""`.quiet();
  const out = r.stdout.toString();
  expect(out).toContain("apps");
  expect(out).toContain("servers");
  expect(out).toContain("login");
  expect(out).not.toContain("__complete");
});

test("__complete apps emits apps subcommands", async () => {
  const r = await $`bun run src/index.ts __complete apps -- ""`.quiet();
  const out = r.stdout.toString();
  expect(out).toContain("ls");
  expect(out).toContain("get");
  expect(out).toContain("deploy");
  expect(out).toContain("restart");
});

test("__complete with --as current emits flags", async () => {
  const r = await $`bun run src/index.ts __complete apps deploy -- --`.quiet();
  const out = r.stdout.toString();
  expect(out).toContain("--ref");
  expect(out).toContain("--wait");
});

test("completion bash emits a thin shim that defers to __complete", async () => {
  const r = await $`bun run src/index.ts completion bash`.quiet();
  const out = r.stdout.toString();
  expect(out).toContain("reoclo __complete");
  expect(out).toContain("complete -F _reoclo reoclo");
});

test("completion zsh emits a thin shim with #compdef header", async () => {
  const r = await $`bun run src/index.ts completion zsh`.quiet();
  const out = r.stdout.toString();
  expect(out.startsWith("#compdef reoclo")).toBe(true);
  expect(out).toContain("reoclo __complete");
});

test("completion fish emits a thin shim that calls __complete", async () => {
  const r = await $`bun run src/index.ts completion fish`.quiet();
  const out = r.stdout.toString();
  expect(out).toContain("reoclo __complete");
  expect(out).toContain("complete -c reoclo");
});
