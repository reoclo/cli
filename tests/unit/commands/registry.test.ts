import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerRegistry, resolveAuthMode } from "../../../src/commands/registry";

describe("registry command group (reads + rm)", () => {
  test("registers ls, get, rm subcommands (create/update/test come in Task 8)", () => {
    const program = new Command().name("reoclo");
    registerRegistry(program);
    const group = program.commands.find((c) => c.name() === "registry");
    expect(group).toBeDefined();
    const names = group!.commands.map((c) => c.name());
    expect(names).toContain("ls");
    expect(names).toContain("get");
    expect(names).toContain("rm");
  });

  test("rm has --yes flag", () => {
    const program = new Command().name("reoclo");
    registerRegistry(program);
    const rm = program.commands
      .find((c) => c.name() === "registry")!
      .commands.find((c) => c.name() === "rm")!;
    const opt = rm.options.find((o) => o.long === "--yes");
    expect(opt).toBeDefined();
  });
});

describe("registry create/update/test", () => {
  test("create has --name, --type, --url, --password-stdin", () => {
    const program = new Command().name("reoclo");
    registerRegistry(program);
    const create = program.commands
      .find((c) => c.name() === "registry")!
      .commands.find((c) => c.name() === "create")!;
    const longs = create.options.map((o) => o.long);
    expect(longs).toContain("--name");
    expect(longs).toContain("--type");
    expect(longs).toContain("--url");
    expect(longs).toContain("--password-stdin");
  });

  test("update accepts <id> and has --password-stdin", () => {
    const program = new Command().name("reoclo");
    registerRegistry(program);
    const update = program.commands
      .find((c) => c.name() === "registry")!
      .commands.find((c) => c.name() === "update")!;
    expect(update.registeredArguments.length).toBe(1);
    const longs = update.options.map((o) => o.long);
    expect(longs).toContain("--password-stdin");
  });

  test("test has --type, --url, --password-stdin", () => {
    const program = new Command().name("reoclo");
    registerRegistry(program);
    const t = program.commands
      .find((c) => c.name() === "registry")!
      .commands.find((c) => c.name() === "test")!;
    const longs = t.options.map((o) => o.long);
    expect(longs).toContain("--type");
    expect(longs).toContain("--url");
    expect(longs).toContain("--password-stdin");
  });
});

describe("resolveAuthMode", () => {
  test("credential only → vault", () => {
    expect(resolveAuthMode("cred-1", "", "", "")).toBe("vault");
  });
  test("all three passthrough fields → passthrough", () => {
    expect(resolveAuthMode("", "user", "tok", "ghcr.io")).toBe("passthrough");
  });
  test("credential AND passthrough → error (mutually exclusive)", () => {
    expect(() => resolveAuthMode("cred-1", "user", "", "")).toThrow(/mutually exclusive/);
  });
  test("neither → error", () => {
    expect(() => resolveAuthMode("", "", "", "")).toThrow(/Provide either/);
  });
  test("partial passthrough → error listing missing fields", () => {
    expect(() => resolveAuthMode("", "user", "", "")).toThrow(/access_token, registry_url/);
  });
});
