import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerLogs, ingestionLooksInactive, formatLogStats } from "../../../src/commands/logs";

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
    for (const flag of [
      "--server",
      "--source-type",
      "--source-name",
      "--stream",
      "--level",
      "--from",
      "--to",
      "--limit",
      "--count",
    ]) {
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

describe("formatLogStats", () => {
  test("returns null when ingestion is inactive (drives the 'no logs' notice)", () => {
    expect(
      formatLogStats({
        total_bytes: 0,
        total_entries: 0,
        total_streams: 0,
        retention_days: 30,
        breakdown_by_server: [],
      }),
    ).toBeNull();
  });

  // Regression: the command previously read `total` / `by_level` (fields the API
  // never returns), so a populated tenant always rendered the empty notice.
  test("formats totals + per-server breakdown from the real /logs/stats shape", () => {
    const out = formatLogStats({
      total_bytes: 228352,
      total_entries: 2375,
      total_streams: 18,
      retention_days: 30,
      breakdown_by_server: [
        { server_id: "a", server_name: "Reoclo Production", bytes: 0, streams: 13 },
        { server_id: "b", server_name: "DevOPS Core Production", bytes: 0, streams: 7 },
      ],
    });
    expect(out).not.toBeNull();
    expect(out!.rows).toEqual([
      { server: "Reoclo Production", streams: 13 },
      { server: "DevOPS Core Production", streams: 7 },
    ]);
    expect(out!.summary).toContain("2375 entries");
    expect(out!.summary).toContain("18 streams");
    expect(out!.summary).toContain("228352 bytes");
    expect(out!.summary).toContain("retention 30d");
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
