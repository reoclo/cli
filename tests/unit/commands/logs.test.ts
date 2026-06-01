import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerLogs, ingestionLooksInactive } from "../../../src/commands/logs";

describe("logs command group", () => {
  test("registers tail (existing) and search subcommands", () => {
    const program = new Command().name("reoclo");
    registerLogs(program);
    const logs = program.commands.find((c) => c.name() === "logs")!;
    const names = logs.commands.map((c) => c.name()).sort();
    expect(names).toContain("search");
    expect(names).toContain("tail");
  });

  test("logs search has all 8 documented filter flags plus --count", () => {
    const program = new Command().name("reoclo");
    registerLogs(program);
    const search = program.commands
      .find((c) => c.name() === "logs")!
      .commands.find((c) => c.name() === "search")!;
    const longs = search.options.map((o) => o.long);
    for (const flag of ["--server", "--source-type", "--source-name", "--stream", "--level", "--from", "--to", "--limit", "--count"]) {
      expect(longs).toContain(flag);
    }
  });
});

describe("ingestionLooksInactive", () => {
  test("true when both streams and bytes are zero/missing", () => {
    expect(ingestionLooksInactive({ total_streams: 0, total_bytes: 0, retention_days: 30 })).toBe(
      true,
    );
    expect(ingestionLooksInactive({ retention_days: 30 })).toBe(true);
  });

  test("false when any ingested data is present", () => {
    expect(ingestionLooksInactive({ total_streams: 5, total_bytes: 0 })).toBe(false);
    expect(ingestionLooksInactive({ total_streams: 0, total_bytes: 1024 })).toBe(false);
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

describe("logs stats + usage", () => {
  test("stats subcommand registered with --from --to", () => {
    const program = new Command().name("reoclo");
    registerLogs(program);
    const stats = program.commands
      .find((c) => c.name() === "logs")!
      .commands.find((c) => c.name() === "stats")!;
    const longs = stats.options.map((o) => o.long);
    expect(longs).toContain("--from");
    expect(longs).toContain("--to");
  });

  test("usage subcommand registered", () => {
    const program = new Command().name("reoclo");
    registerLogs(program);
    const usage = program.commands
      .find((c) => c.name() === "logs")!
      .commands.find((c) => c.name() === "usage")!;
    expect(usage).toBeDefined();
  });
});
