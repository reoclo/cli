import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerDeployments } from "../../../src/commands/deployments";
import { getCompletionSpec } from "../../../src/client/command-meta";

describe("deployments stages", () => {
  test("stages subcommand registered with <id> arg + withCompletion(deployments)", () => {
    const program = new Command().name("reoclo");
    registerDeployments(program);
    const stages = program.commands
      .find((c) => c.name() === "deployments")!
      .commands.find((c) => c.name() === "stages")!;
    expect(stages).toBeDefined();
    const spec = getCompletionSpec(stages);
    expect(spec).toBeDefined();
    expect(spec!.args).toEqual([{ slot: 0, resource: "deployments" }]);
  });
});
