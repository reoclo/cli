import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerServers } from "../../../src/commands/servers";
import { getCompletionSpec, getRequiredCapability } from "../../../src/client/command-meta";

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

test("servers containers is gated by container:read", () => {
  const p = new Command();
  registerServers(p);
  const g = p.commands.find((c) => c.name() === "servers")!;
  const ctr = g.commands.find((c) => c.name() === "containers")!;
  expect(getRequiredCapability(ctr)).toBe("container:read");
});

test("servers set-role takes a server and a role, completing the server", () => {
  const p = new Command();
  registerServers(p);
  const setRole = p.commands.find((c) => c.name() === "servers")!.commands.find((c) => c.name() === "set-role")!;
  expect(setRole.usage()).toContain("idOrSlug");
  expect(setRole.usage()).toContain("role");
  expect(getCompletionSpec(setRole)?.args).toEqual([{ slot: 0, resource: "servers" }]);
});

test("servers set-role rejects an unknown role with exit 2 before any request", async () => {
  const p = new Command();
  registerServers(p);
  const err = await p.parseAsync(["node", "reoclo", "servers", "set-role", "web1", "bogus"]).catch((e: unknown) => e);
  expect((err as { exitCode?: number }).exitCode).toBe(2);
});
