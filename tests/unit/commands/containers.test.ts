import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerContainers } from "../../../src/commands/containers";
import { getRequiredCapability } from "../../../src/client/command-meta";
import { filterCommandsByCapability } from "../../../src/client/help-filter";

function containersCmd(): Command {
  const p = new Command().name("reoclo");
  registerContainers(p);
  return p.commands.find((c) => c.name() === "containers")!;
}

describe("reoclo containers", () => {
  test("registers ls and refresh", () => {
    const names = containersCmd().commands.map((c) => c.name());
    expect(names).toContain("ls");
    expect(names).toContain("refresh");
  });

  test("ls and refresh carry the container:read capability tag", () => {
    const g = containersCmd();
    const ls = g.commands.find((c) => c.name() === "ls")!;
    const refresh = g.commands.find((c) => c.name() === "refresh")!;
    expect(getRequiredCapability(ls)).toBe("container:read");
    expect(getRequiredCapability(refresh)).toBe("container:read");
  });

  test("a capability-less profile hides the containers commands", () => {
    const p = new Command().name("reoclo");
    registerContainers(p);
    filterCommandsByCapability(p, []);
    const g = p.commands.find((c) => c.name() === "containers")!;
    const ls = g.commands.find((c) => c.name() === "ls")!;
    expect((ls as unknown as { _hidden?: boolean })._hidden).toBe(true);
  });

  test("registers recreate/scale/labels with container:write", () => {
    const g = containersCmd();
    for (const n of ["recreate", "scale", "labels"]) {
      const c = g.commands.find((x) => x.name() === n)!;
      expect(c, `${n} registered`).toBeDefined();
      expect(getRequiredCapability(c)).toBe("container:write");
    }
  });
});
