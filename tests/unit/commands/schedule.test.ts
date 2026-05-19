import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerSchedule } from "../../../src/commands/schedule";
import { getCompletionSpec } from "../../../src/client/command-meta";

function scheduleCmd(): Command {
  const p = new Command();
  registerSchedule(p);
  return p.commands.find((c) => c.name() === "schedule")!;
}

describe("reoclo schedule", () => {
  test("registers the core CRUD subcommands", () => {
    const names = scheduleCmd().commands.map((c) => c.name());
    for (const n of ["ls", "get", "create", "update", "rm"]) {
      expect(names).toContain(n);
    }
  });

  test("create requires --name/--type/--schedule", () => {
    const create = scheduleCmd().commands.find((c) => c.name() === "create")!;
    const flags = create.options.map((o) => o.long);
    expect(flags).toContain("--name");
    expect(flags).toContain("--type");
    expect(flags).toContain("--schedule");
  });

  test("create has enum completion for --type/--schedule/--concurrency", () => {
    const create = scheduleCmd().commands.find((c) => c.name() === "create")!;
    const spec = getCompletionSpec(create);
    expect(spec?.flags?.["--type"]).toEqual({
      enum: ["DEPLOY", "COMMAND", "RESTART", "REBOOT"],
    });
    expect(spec?.flags?.["--schedule"]).toEqual({ enum: ["CRON", "ONCE"] });
    expect(spec?.flags?.["--concurrency"]).toEqual({
      enum: ["SKIP", "QUEUE", "REPLACE"],
    });
  });
});
