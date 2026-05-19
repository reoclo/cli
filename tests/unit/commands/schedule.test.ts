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
  test("registers all subcommands", () => {
    const names = scheduleCmd().commands.map((c) => c.name()).sort();
    expect(names).toEqual(
      ["create", "get", "ls", "pause", "resume", "rm", "run", "runs", "trigger", "update"].sort(),
    );
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

  test("runs has --status enum completion", () => {
    const runs = scheduleCmd().commands.find((c) => c.name() === "runs")!;
    const spec = getCompletionSpec(runs);
    expect(spec?.flags?.["--status"]).toEqual({
      enum: ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "SKIPPED", "CANCELLED", "TIMED_OUT"],
    });
  });
});
