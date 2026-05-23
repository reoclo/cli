import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerAlerts } from "../../../src/commands/alerts";
import { getCompletionSpec } from "../../../src/client/command-meta";

function alertsCmd(): Command {
  const p = new Command();
  registerAlerts(p);
  return p.commands.find((c) => c.name() === "alerts")!;
}

describe("reoclo alerts", () => {
  test("registers top-level subcommands", () => {
    const names = alertsCmd().commands.map((c) => c.name()).sort();
    expect(names).toContain("catalog");
    expect(names).toContain("list");
    expect(names).toContain("get");
    expect(names).toContain("ack");
    expect(names).toContain("resolve");
    expect(names).toContain("history");
    expect(names).toContain("mute");
    expect(names).toContain("mutes");
    expect(names).toContain("unmute");
    expect(names).toContain("routing");
  });

  // catalog subcommands
  test("catalog registers ls, get, update", () => {
    const catalog = alertsCmd().commands.find((c) => c.name() === "catalog")!;
    const names = catalog.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["get", "ls", "update"].sort());
  });

  test("catalog get has completion for alert-codes arg", () => {
    const catalog = alertsCmd().commands.find((c) => c.name() === "catalog")!;
    const get = catalog.commands.find((c) => c.name() === "get")!;
    const spec = getCompletionSpec(get);
    expect(spec?.args?.[0]).toEqual({ slot: 0, resource: "alert-codes" });
  });

  test("catalog update has expected flags", () => {
    const catalog = alertsCmd().commands.find((c) => c.name() === "catalog")!;
    const update = catalog.commands.find((c) => c.name() === "update")!;
    const flags = update.options.map((o) => o.long);
    expect(flags).toContain("--warn");
    expect(flags).toContain("--critical");
    expect(flags).toContain("--clear");
    expect(flags).toContain("--consecutive-to-fire");
    expect(flags).toContain("--consecutive-to-clear");
    expect(flags).toContain("--enabled");
  });

  // list command
  test("list has --state, --severity, --resource, --since flags", () => {
    const list = alertsCmd().commands.find((c) => c.name() === "list")!;
    const flags = list.options.map((o) => o.long);
    expect(flags).toContain("--state");
    expect(flags).toContain("--severity");
    expect(flags).toContain("--resource");
    expect(flags).toContain("--since");
  });

  test("list has enum completion for --state and --severity", () => {
    const list = alertsCmd().commands.find((c) => c.name() === "list")!;
    const spec = getCompletionSpec(list);
    expect(spec?.flags?.["--state"]).toEqual({
      enum: ["firing", "acknowledged", "resolved"],
    });
    expect(spec?.flags?.["--severity"]).toEqual({
      enum: ["info", "warn", "critical"],
    });
  });

  // get command
  test("get has completion for alert-instances arg", () => {
    const get = alertsCmd().commands.find((c) => c.name() === "get")!;
    const spec = getCompletionSpec(get);
    expect(spec?.args?.[0]).toEqual({ slot: 0, resource: "alert-instances" });
  });

  // ack command
  test("ack has --note flag and alert-instances completion", () => {
    const ack = alertsCmd().commands.find((c) => c.name() === "ack")!;
    const flags = ack.options.map((o) => o.long);
    expect(flags).toContain("--note");
    const spec = getCompletionSpec(ack);
    expect(spec?.args?.[0]).toEqual({ slot: 0, resource: "alert-instances" });
  });

  // resolve command
  test("resolve requires --note and has alert-instances completion", () => {
    const resolve = alertsCmd().commands.find((c) => c.name() === "resolve")!;
    const noteOpt = resolve.options.find((o) => o.long === "--note");
    expect(noteOpt).toBeDefined();
    expect(noteOpt?.mandatory).toBe(true);
    const spec = getCompletionSpec(resolve);
    expect(spec?.args?.[0]).toEqual({ slot: 0, resource: "alert-instances" });
  });

  // history command
  test("history has --since flag", () => {
    const history = alertsCmd().commands.find((c) => c.name() === "history")!;
    const flags = history.options.map((o) => o.long);
    expect(flags).toContain("--since");
  });

  // mute command
  test("mute has --resource, --for, --reason, --confirm flags", () => {
    const mute = alertsCmd().commands.find((c) => c.name() === "mute")!;
    const flags = mute.options.map((o) => o.long);
    expect(flags).toContain("--resource");
    expect(flags).toContain("--for");
    expect(flags).toContain("--reason");
    expect(flags).toContain("--confirm");
  });

  test("mute has alert-codes completion for positional arg", () => {
    const mute = alertsCmd().commands.find((c) => c.name() === "mute")!;
    const spec = getCompletionSpec(mute);
    expect(spec?.args?.[0]).toEqual({ slot: 0, resource: "alert-codes" });
  });

  // mutes subcommand
  test("mutes registers list subcommand", () => {
    const mutes = alertsCmd().commands.find((c) => c.name() === "mutes")!;
    const names = mutes.commands.map((c) => c.name());
    expect(names).toContain("list");
  });

  // unmute command
  test("unmute has completion for alert-mutes arg", () => {
    const unmute = alertsCmd().commands.find((c) => c.name() === "unmute")!;
    const spec = getCompletionSpec(unmute);
    expect(spec?.args?.[0]).toEqual({ slot: 0, resource: "alert-mutes" });
  });

  // routing subcommands
  test("routing registers get, set, override", () => {
    const routing = alertsCmd().commands.find((c) => c.name() === "routing")!;
    const names = routing.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["get", "override", "set"].sort());
  });

  test("routing override has alert-codes completion", () => {
    const routing = alertsCmd().commands.find((c) => c.name() === "routing")!;
    const override = routing.commands.find((c) => c.name() === "override")!;
    const spec = getCompletionSpec(override);
    expect(spec?.args?.[0]).toEqual({ slot: 0, resource: "alert-codes" });
  });

  test("routing set requires --from-file", () => {
    const routing = alertsCmd().commands.find((c) => c.name() === "routing")!;
    const set = routing.commands.find((c) => c.name() === "set")!;
    const fromFile = set.options.find((o) => o.long === "--from-file");
    expect(fromFile).toBeDefined();
    expect(fromFile?.mandatory).toBe(true);
  });
});
