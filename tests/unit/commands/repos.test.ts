import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerRepos } from "../../../src/commands/repos";
import { getCompletionSpec } from "../../../src/client/command-meta";

describe("repos command group", () => {
  test("registers ls, get, branches subcommands", () => {
    const program = new Command().name("reoclo");
    registerRepos(program);
    const group = program.commands.find((c) => c.name() === "repos");
    expect(group).toBeDefined();
    const names = group!.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["branches", "get", "ls"]);
  });

  test("repos get has withCompletion(slot 0 → repos)", () => {
    const program = new Command().name("reoclo");
    registerRepos(program);
    const get = program.commands
      .find((c) => c.name() === "repos")!
      .commands.find((c) => c.name() === "get")!;
    const spec = getCompletionSpec(get);
    expect(spec).toBeDefined();
    expect(spec!.args).toEqual([{ slot: 0, resource: "repos" }]);
  });

  test("repos branches has withCompletion(slot 0 → repos)", () => {
    const program = new Command().name("reoclo");
    registerRepos(program);
    const branches = program.commands
      .find((c) => c.name() === "repos")!
      .commands.find((c) => c.name() === "branches")!;
    const spec = getCompletionSpec(branches);
    expect(spec).toBeDefined();
    expect(spec!.args).toEqual([{ slot: 0, resource: "repos" }]);
  });
});
