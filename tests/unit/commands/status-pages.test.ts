import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerStatusPages } from "../../../src/commands/status-pages";

function spCmd(): Command {
  const p = new Command();
  registerStatusPages(p);
  return p.commands.find((c) => c.name() === "status-pages")!;
}

describe("reoclo status-pages", () => {
  test("registers all subcommands", () => {
    const names = spCmd().commands.map((c) => c.name());
    expect(names.sort()).toEqual(["create", "get", "ls", "rm", "update"].sort());
  });

  test("create has --title/--label/--description and no required option", () => {
    const create = spCmd().commands.find((c) => c.name() === "create")!;
    const flags = create.options.map((o) => o.long);
    expect(flags).toContain("--title");
    expect(flags).toContain("--label");
    expect(flags).toContain("--description");
    expect(create.options.every((o) => !o.mandatory)).toBe(true);
  });

  test("update has --title/--label/--description/--published", () => {
    const update = spCmd().commands.find((c) => c.name() === "update")!;
    const flags = update.options.map((o) => o.long);
    expect(flags).toContain("--title");
    expect(flags).toContain("--label");
    expect(flags).toContain("--description");
    expect(flags).toContain("--published");
  });
});
