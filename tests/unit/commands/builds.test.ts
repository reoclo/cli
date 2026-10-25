import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerBuilds } from "../../../src/commands/builds";
import { getCompletionSpec, getRequiredCapability } from "../../../src/client/command-meta";
import { BUILD_STATUSES } from "../../../src/client/enums";

function builds(): Command {
  const program = new Command().name("reoclo");
  registerBuilds(program);
  return program.commands.find((c) => c.name() === "builds")!;
}

function sub(name: string): Command {
  return builds().commands.find((c) => c.name() === name)!;
}

describe("reoclo builds", () => {
  test("registers ls, get, logs and cancel", () => {
    expect(builds().commands.map((c) => c.name()).sort()).toEqual(["cancel", "get", "logs", "ls"]);
  });

  test("ls takes --app, --status and pagination flags", () => {
    const longs = sub("ls").options.map((o) => o.long);
    for (const flag of ["--app", "--status", "--skip", "--limit"]) expect(longs).toContain(flag);
  });

  test("ls completes --app to apps and --status to the build statuses", () => {
    expect(getCompletionSpec(sub("ls"))?.flags).toEqual({
      "--app": "apps",
      "--status": { enum: [...BUILD_STATUSES] },
    });
  });

  test("cancel is gated by app:deploy", () => {
    expect(getRequiredCapability(sub("cancel"))).toBe("app:deploy");
  });

  test("ls with an unknown --status fails with exit 2 before any request", async () => {
    const program = new Command().name("reoclo");
    registerBuilds(program);
    const err = await program.parseAsync(["node", "reoclo", "builds", "ls", "--status", "bogus"]).catch((e: unknown) => e);
    expect((err as { exitCode?: number }).exitCode).toBe(2);
  });
});
