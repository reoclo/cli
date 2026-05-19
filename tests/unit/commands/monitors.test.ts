import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerMonitors } from "../../../src/commands/monitors";

function monitorsCmd(): Command {
  const p = new Command();
  registerMonitors(p);
  return p.commands.find((c) => c.name() === "monitors")!;
}

describe("reoclo monitors", () => {
  test("registers all subcommands", () => {
    const names = monitorsCmd().commands.map((c) => c.name());
    expect(names.sort()).toEqual(
      ["create", "get", "ls", "pause", "resume", "rm", "update"].sort(),
    );
  });

  test("create requires --name and --url", () => {
    const create = monitorsCmd().commands.find((c) => c.name() === "create")!;
    const flags = create.options.map((o) => o.long);
    expect(flags).toContain("--name");
    expect(flags).toContain("--url");
    expect(flags).toContain("--interval");
  });
});
