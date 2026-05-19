import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerIncidents } from "../../../src/commands/incidents";
import { getCompletionSpec } from "../../../src/client/command-meta";

function incCmd(): Command {
  const p = new Command();
  registerIncidents(p);
  return p.commands.find((c) => c.name() === "incidents")!;
}

describe("reoclo incidents", () => {
  test("registers all subcommands", () => {
    const names = incCmd().commands.map((c) => c.name());
    expect(names.sort()).toEqual(
      ["add-update", "create", "get", "ls", "update"].sort(),
    );
  });

  test("create has --severity enum completion", () => {
    const create = incCmd().commands.find((c) => c.name() === "create")!;
    const spec = getCompletionSpec(create);
    expect(spec?.flags?.["--severity"]).toEqual({
      enum: ["minor", "major", "critical"],
    });
  });

  test("update has --state and --severity enum completion", () => {
    const update = incCmd().commands.find((c) => c.name() === "update")!;
    const spec = getCompletionSpec(update);
    expect(spec?.flags?.["--state"]).toEqual({
      enum: ["investigating", "identified", "monitoring", "resolved"],
    });
    expect(spec?.flags?.["--severity"]).toEqual({ enum: ["minor", "major", "critical"] });
  });

  test("add-update has --state enum completion", () => {
    const addUpdate = incCmd().commands.find((c) => c.name() === "add-update")!;
    const spec = getCompletionSpec(addUpdate);
    expect(spec?.flags?.["--state"]).toEqual({
      enum: ["investigating", "identified", "monitoring", "resolved"],
    });
  });
});
