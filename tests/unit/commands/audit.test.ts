import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerAudit } from "../../../src/commands/audit";

describe("audit command group", () => {
  test("registers ls subcommand only", () => {
    const program = new Command().name("reoclo");
    registerAudit(program);
    const group = program.commands.find((c) => c.name() === "audit");
    expect(group).toBeDefined();
    const names = group!.commands.map((c) => c.name());
    expect(names).toEqual(["ls"]);
  });

  test("ls exposes all 7 documented filter flags", () => {
    const program = new Command().name("reoclo");
    registerAudit(program);
    const ls = program.commands
      .find((c) => c.name() === "audit")!
      .commands.find((c) => c.name() === "ls")!;
    const longs = ls.options.map((o) => o.long);
    for (const flag of [
      "--actor",
      "--action",
      "--resource-type",
      "--resource-id",
      "--from",
      "--to",
      "--limit",
    ]) {
      expect(longs).toContain(flag);
    }
  });
});
