import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerDomains } from "../../../src/commands/domains";
import { getCompletionSpec } from "../../../src/client/command-meta";

describe("domains dns/health/rm", () => {
  test("all three subcommands registered with withCompletion(domains)", () => {
    const program = new Command().name("reoclo");
    registerDomains(program);
    const domains = program.commands.find((c) => c.name() === "domains")!;
    const names = domains.commands.map((c) => c.name());
    for (const n of ["dns", "health", "rm"]) {
      expect(names).toContain(n);
    }
    for (const n of ["dns", "health", "rm"]) {
      const cmd = domains.commands.find((c) => c.name() === n)!;
      const spec = getCompletionSpec(cmd);
      expect(spec).toBeDefined();
      expect(spec!.args).toEqual([{ slot: 0, resource: "domains" }]);
    }
  });

  test("rm has --yes flag", () => {
    const program = new Command().name("reoclo");
    registerDomains(program);
    const rm = program.commands
      .find((c) => c.name() === "domains")!
      .commands.find((c) => c.name() === "rm")!;
    const longs = rm.options.map((o) => o.long);
    expect(longs).toContain("--yes");
  });
});
