import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerDashboard } from "../../../src/commands/dashboard";

describe("dashboard top-level command", () => {
  test("registers dashboard as a top-level command (no subcommands)", () => {
    const program = new Command().name("reoclo");
    registerDashboard(program);
    const cmd = program.commands.find((c) => c.name() === "dashboard");
    expect(cmd).toBeDefined();
    expect(cmd!.commands.length).toBe(0);
  });
});
