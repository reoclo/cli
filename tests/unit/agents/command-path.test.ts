// tests/unit/agents/command-path.test.ts
//
// The command an agent runs is the path the user invoked reoclo by, so a
// symlink such as ~/.local/bin/reoclo stays valid when the binary behind it moves.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveServerCommand } from "../../../src/agents/command-path";
import { AgentConfigError } from "../../../src/agents/errors";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "reoclo-cmdpath-")));
  mkdirSync(join(dir, "app"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "app", "reoclo-real"), "");
  symlinkSync(join(dir, "app", "reoclo-real"), join(dir, "bin", "reoclo"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const neverOnPath = (): string | null => null;

test("an absolute invocation keeps the symlink instead of its target", () => {
  const link = join(dir, "bin", "reoclo");
  expect(resolveServerCommand({ override: undefined, argv0: link, cwd: "/", which: neverOnPath })).toBe(link);
});

test("a relative invocation is made absolute against the working directory", () => {
  const out = resolveServerCommand({ override: undefined, argv0: "./bin/reoclo", cwd: dir, which: neverOnPath });
  expect(out).toBe(join(dir, "bin", "reoclo"));
});

test("a bare name is found on PATH", () => {
  const link = join(dir, "bin", "reoclo");
  const out = resolveServerCommand({ override: undefined, argv0: "reoclo", cwd: "/", which: () => link });
  expect(out).toBe(link);
});

test("the rc alias counts as reoclo", () => {
  const out = resolveServerCommand({ override: undefined, argv0: join(dir, "bin", "rc"), cwd: "/", which: neverOnPath });
  expect(out).toBe(join(dir, "bin", "rc"));
});

test("--command wins and is made absolute", () => {
  const out = resolveServerCommand({ override: "app/reoclo-real", argv0: "bun", cwd: dir, which: neverOnPath });
  expect(out).toBe(join(dir, "app", "reoclo-real"));
});

test("--command must exist", () => {
  const run = (): string => resolveServerCommand({ override: join(dir, "nope"), argv0: "reoclo", cwd: dir, which: neverOnPath });
  expect(run).toThrow(AgentConfigError);
});

test("an invocation that is not reoclo cannot be registered", () => {
  const run = (): string => resolveServerCommand({ override: undefined, argv0: "/usr/local/bin/bun", cwd: dir, which: neverOnPath });
  expect(run).toThrow(AgentConfigError);
});
