import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerChannels } from "../../../src/commands/channels";
import { getCompletionSpec } from "../../../src/client/command-meta";

function channelsCmd(): Command {
  const p = new Command();
  registerChannels(p);
  return p.commands.find((c) => c.name() === "channels")!;
}

describe("reoclo channels", () => {
  test("registers all subcommands", () => {
    const names = channelsCmd().commands.map((c) => c.name()).sort();
    expect(names).toEqual(
      ["create", "delete", "disable", "enable", "get", "kinds", "list", "test", "update"].sort(),
    );
  });

  // list
  test("list has --kind and --enabled flags", () => {
    const list = channelsCmd().commands.find((c) => c.name() === "list")!;
    const flags = list.options.map((o) => o.long);
    expect(flags).toContain("--kind");
    expect(flags).toContain("--enabled");
  });

  // get
  test("get has channel-ids completion for positional arg", () => {
    const get = channelsCmd().commands.find((c) => c.name() === "get")!;
    const spec = getCompletionSpec(get);
    expect(spec?.args?.[0]).toEqual({ slot: 0, resource: "channel-ids" });
  });

  // create
  test("create has --name, --config, --secret, --from-file, --events, --disabled flags", () => {
    const create = channelsCmd().commands.find((c) => c.name() === "create")!;
    const flags = create.options.map((o) => o.long);
    expect(flags).toContain("--name");
    expect(flags).toContain("--config");
    expect(flags).toContain("--secret");
    expect(flags).toContain("--from-file");
    expect(flags).toContain("--events");
    expect(flags).toContain("--disabled");
  });

  test("create --name is required", () => {
    const create = channelsCmd().commands.find((c) => c.name() === "create")!;
    const nameOpt = create.options.find((o) => o.long === "--name");
    expect(nameOpt).toBeDefined();
    expect(nameOpt?.mandatory).toBe(true);
  });

  test("create has channel-kinds completion for positional arg", () => {
    const create = channelsCmd().commands.find((c) => c.name() === "create")!;
    const spec = getCompletionSpec(create);
    expect(spec?.args?.[0]).toEqual({ slot: 0, resource: "channel-kinds" });
  });

  // update
  test("update has channel-ids completion for positional arg", () => {
    const update = channelsCmd().commands.find((c) => c.name() === "update")!;
    const spec = getCompletionSpec(update);
    expect(spec?.args?.[0]).toEqual({ slot: 0, resource: "channel-ids" });
  });

  test("update has --name, --config, --secret, --events, --enabled flags", () => {
    const update = channelsCmd().commands.find((c) => c.name() === "update")!;
    const flags = update.options.map((o) => o.long);
    expect(flags).toContain("--name");
    expect(flags).toContain("--config");
    expect(flags).toContain("--secret");
    expect(flags).toContain("--events");
    expect(flags).toContain("--enabled");
  });

  // delete
  test("delete has channel-ids completion and --force flag", () => {
    const del = channelsCmd().commands.find((c) => c.name() === "delete")!;
    const spec = getCompletionSpec(del);
    expect(spec?.args?.[0]).toEqual({ slot: 0, resource: "channel-ids" });
    expect(del.options.map((o) => o.long)).toContain("--force");
  });

  // test
  test("test has channel-ids completion and --to flag", () => {
    const testCmd = channelsCmd().commands.find((c) => c.name() === "test")!;
    const spec = getCompletionSpec(testCmd);
    expect(spec?.args?.[0]).toEqual({ slot: 0, resource: "channel-ids" });
    expect(testCmd.options.map((o) => o.long)).toContain("--to");
  });

  // enable / disable
  test("enable has channel-ids completion", () => {
    const enable = channelsCmd().commands.find((c) => c.name() === "enable")!;
    const spec = getCompletionSpec(enable);
    expect(spec?.args?.[0]).toEqual({ slot: 0, resource: "channel-ids" });
  });

  test("disable has channel-ids completion", () => {
    const disable = channelsCmd().commands.find((c) => c.name() === "disable")!;
    const spec = getCompletionSpec(disable);
    expect(spec?.args?.[0]).toEqual({ slot: 0, resource: "channel-ids" });
  });
});
