import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerServers } from "../../../src/commands/servers";

describe("reoclo servers", () => {
  test("set-slug subcommand is registered", () => {
    const prog = new Command();
    registerServers(prog);
    const setSlug = prog.commands
      .find((c) => c.name() === "servers")
      ?.commands.find((c) => c.name() === "set-slug");
    expect(setSlug).toBeDefined();
    expect(setSlug?.description()).toMatch(/slug/i);
  });

  test("set-slug expects two positional args", () => {
    const prog = new Command();
    registerServers(prog);
    const setSlug = prog.commands
      .find((c) => c.name() === "servers")
      ?.commands.find((c) => c.name() === "set-slug");
    expect(setSlug?.usage()).toContain("idOrSlug");
    expect(setSlug?.usage()).toContain("newSlug");
  });
});

test("servers has the runtime/health extension subcommands", () => {
  const p = new Command();
  registerServers(p);
  const g = p.commands.find((c) => c.name() === "servers")!;
  const names = g.commands.map((c) => c.name());
  for (const n of ["containers", "health", "ports", "uptime", "reboot"]) {
    expect(names).toContain(n);
  }
});

test("servers reboot has a --yes flag", () => {
  const p = new Command();
  registerServers(p);
  const g = p.commands.find((c) => c.name() === "servers")!;
  const reboot = g.commands.find((c) => c.name() === "reboot")!;
  expect(reboot.options.map((o) => o.long)).toContain("--yes");
});
