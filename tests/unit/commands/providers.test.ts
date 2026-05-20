import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerProviders } from "../../../src/commands/providers";
import { getCompletionSpec } from "../../../src/client/command-meta";

describe("providers command registration", () => {
  test("registers ls/get/create/connect/test/sync/status/orgs/webhook-url/update/rm", () => {
    const program = new Command().name("reoclo");
    registerProviders(program);
    const providers = program.commands.find((c) => c.name() === "providers");
    expect(providers).toBeDefined();
    const subs = providers!.commands.map((c) => c.name());
    expect(subs).toEqual(
      expect.arrayContaining([
        "ls", "get", "create", "connect", "test", "sync",
        "status", "orgs", "webhook-url", "update", "rm",
      ]),
    );
    expect(subs).toHaveLength(11);
  });

  test("get has withCompletion(slot 0 → providers)", () => {
    const program = new Command().name("reoclo");
    registerProviders(program);
    const get = program.commands
      .find((c) => c.name() === "providers")!
      .commands.find((c) => c.name() === "get")!;
    const spec = getCompletionSpec(get);
    expect(spec).toBeDefined();
    expect(spec!.args).toEqual([{ slot: 0, resource: "providers" }]);
  });

  test("rm has withCompletion(slot 0 → providers)", () => {
    const program = new Command().name("reoclo");
    registerProviders(program);
    const rm = program.commands
      .find((c) => c.name() === "providers")!
      .commands.find((c) => c.name() === "rm")!;
    const spec = getCompletionSpec(rm);
    expect(spec).toBeDefined();
    expect(spec!.args).toEqual([{ slot: 0, resource: "providers" }]);
  });
});
