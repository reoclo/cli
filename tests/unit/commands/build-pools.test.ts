import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerBuildPools } from "../../../src/commands/build-pools";
import { getCompletionSpec } from "../../../src/client/command-meta";

function pools(): Command {
  const program = new Command().name("reoclo");
  registerBuildPools(program);
  return program.commands.find((c) => c.name() === "build-pools")!;
}

function sub(name: string): Command {
  return pools().commands.find((c) => c.name() === name)!;
}

describe("reoclo build-pools", () => {
  test("registers ls, get, create, set and rm", () => {
    expect(pools().commands.map((c) => c.name()).sort()).toEqual(["create", "get", "ls", "rm", "set"]);
  });

  test("ls paginates with --skip and --limit", () => {
    const longs = sub("ls").options.map((o) => o.long);
    expect(longs).toContain("--skip");
    expect(longs).toContain("--limit");
  });

  test("create takes --name, repeatable --server and --max-concurrent", () => {
    const longs = sub("create").options.map((o) => o.long);
    for (const flag of ["--name", "--server", "--max-concurrent"]) expect(longs).toContain(flag);
  });

  test("create and set complete --server to servers", () => {
    expect(getCompletionSpec(sub("create"))?.flags).toEqual({ "--server": "servers" });
    expect(getCompletionSpec(sub("set"))?.flags).toEqual({ "--server": "servers" });
  });

  test("rm has --yes", () => {
    expect(sub("rm").options.map((o) => o.long)).toContain("--yes");
  });

  test("create without --server fails with exit 2 before any request", async () => {
    const program = new Command().name("reoclo");
    registerBuildPools(program);
    const err = await program.parseAsync(["node", "reoclo", "build-pools", "create", "--name", "p"]).catch((e: unknown) => e);
    expect((err as { exitCode?: number }).exitCode).toBe(2);
  });

  test("set with no fields fails with exit 2 before any request", async () => {
    const program = new Command().name("reoclo");
    registerBuildPools(program);
    const err = await program.parseAsync(["node", "reoclo", "build-pools", "set", "p"]).catch((e: unknown) => e);
    expect((err as { exitCode?: number }).exitCode).toBe(2);
  });
});
