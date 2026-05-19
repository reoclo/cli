import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerRegistry } from "../../../src/commands/registry";

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
