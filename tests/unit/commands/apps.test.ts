import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerApps } from "../../../src/commands/apps";
import { getCompletionSpec } from "../../../src/client/command-meta";

describe("apps config subgroup", () => {
  test("registers config subgroup with get and set", () => {
    const program = new Command().name("reoclo");
    registerApps(program);
    const apps = program.commands.find((c) => c.name() === "apps")!;
    const config = apps.commands.find((c) => c.name() === "config");
    expect(config).toBeDefined();
    const names = config!.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["get", "set"]);
  });

  test("apps config get has withCompletion(slot 0 → apps)", () => {
    const program = new Command().name("reoclo");
    registerApps(program);
    const get = program.commands
      .find((c) => c.name() === "apps")!
      .commands.find((c) => c.name() === "config")!
      .commands.find((c) => c.name() === "get")!;
    const spec = getCompletionSpec(get);
    expect(spec).toBeDefined();
    expect(spec!.args).toEqual([{ slot: 0, resource: "apps" }]);
  });

  test("apps config set has all 7 documented flags", () => {
    const program = new Command().name("reoclo");
    registerApps(program);
    const set = program.commands
      .find((c) => c.name() === "apps")!
      .commands.find((c) => c.name() === "config")!
      .commands.find((c) => c.name() === "set")!;
    const longs = set.options.map((o) => o.long);
    for (const flag of ["--buildpack", "--docker-image", "--container-port", "--host-port", "--replicas", "--env", "--set"]) {
      expect(longs).toContain(flag);
    }
  });
});
