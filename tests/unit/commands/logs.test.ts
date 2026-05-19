import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerLogs } from "../../../src/commands/logs";

describe("logs command group", () => {
  test("registers tail (existing) and search subcommands", () => {
    const program = new Command().name("reoclo");
    registerLogs(program);
    const logs = program.commands.find((c) => c.name() === "logs")!;
    const names = logs.commands.map((c) => c.name()).sort();
    expect(names).toContain("search");
    expect(names).toContain("tail");
  });

  test("logs search has all 8 documented filter flags", () => {
    const program = new Command().name("reoclo");
    registerLogs(program);
    const search = program.commands
      .find((c) => c.name() === "logs")!
      .commands.find((c) => c.name() === "search")!;
    const longs = search.options.map((o) => o.long);
    for (const flag of ["--server", "--source-type", "--source-name", "--stream", "--level", "--from", "--to", "--limit"]) {
      expect(longs).toContain(flag);
    }
  });
});

describe("logs system + sources", () => {
  test("system subcommand registered with --unit --tail --since --search --level", () => {
    const program = new Command().name("reoclo");
    registerLogs(program);
    const system = program.commands
      .find((c) => c.name() === "logs")!
      .commands.find((c) => c.name() === "system")!;
    const longs = system.options.map((o) => o.long);
    for (const flag of ["--unit", "--tail", "--since", "--search", "--level"]) {
      expect(longs).toContain(flag);
    }
  });

  test("sources subcommand registered", () => {
    const program = new Command().name("reoclo");
    registerLogs(program);
    const sources = program.commands
      .find((c) => c.name() === "logs")!
      .commands.find((c) => c.name() === "sources")!;
    expect(sources).toBeDefined();
  });
});
