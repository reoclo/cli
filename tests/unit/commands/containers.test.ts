import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerContainers, filterByName } from "../../../src/commands/containers";
import { getRequiredCapability } from "../../../src/client/command-meta";
import { filterCommandsByCapability } from "../../../src/client/help-filter";

function containersCmd(): Command {
  const p = new Command().name("reoclo");
  registerContainers(p);
  return p.commands.find((c) => c.name() === "containers")!;
}

function optNames(cmd: Command): string[] {
  return cmd.options.map((o) => o.long ?? o.short ?? "");
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

  test("a known cap list that lacks container:read hides the gated commands", () => {
    // An empty array or undefined now means "unknown — show everything", so
    // pass a non-empty list that explicitly does not include container:read
    // to exercise the hide path.
    const p = new Command().name("reoclo");
    registerContainers(p);
    filterCommandsByCapability(p, ["something:else"]);
    const g = p.commands.find((c) => c.name() === "containers")!;
    const ls = g.commands.find((c) => c.name() === "ls")!;
    expect((ls as unknown as { _hidden?: boolean })._hidden).toBe(true);
  });

  test("an empty / unknown cap list shows the containers commands (server enforces)", () => {
    const p = new Command().name("reoclo");
    registerContainers(p);
    filterCommandsByCapability(p, []);
    const g = p.commands.find((c) => c.name() === "containers")!;
    const ls = g.commands.find((c) => c.name() === "ls")!;
    expect((ls as unknown as { _hidden?: boolean })._hidden ?? false).toBe(false);
  });

  test("registers recreate/scale/labels with container:write", () => {
    const g = containersCmd();
    for (const n of ["recreate", "scale", "labels"]) {
      const c = g.commands.find((x) => x.name() === n)!;
      expect(c, `${n} registered`).toBeDefined();
      expect(getRequiredCapability(c)).toBe("container:write");
    }
  });

  test("registers inspect/logs/restart with the right capabilities", () => {
    const g = containersCmd();
    expect(getRequiredCapability(g.commands.find((c) => c.name() === "inspect")!)).toBe(
      "container:read",
    );
    expect(getRequiredCapability(g.commands.find((c) => c.name() === "logs")!)).toBe(
      "container:logs:tail",
    );
    expect(getRequiredCapability(g.commands.find((c) => c.name() === "restart")!)).toBe(
      "container:write",
    );
  });

  test("inspect exposes --show-secrets (masked by default)", () => {
    const g = containersCmd();
    const inspect = g.commands.find((c) => c.name() === "inspect")!;
    expect(optNames(inspect)).toContain("--show-secrets");
  });

  test("ls exposes the --name substring filter", () => {
    const g = containersCmd();
    const ls = g.commands.find((c) => c.name() === "ls")!;
    expect(optNames(ls)).toContain("--name");
  });

  test("logs exposes --since/--search/--follow for the streaming source", () => {
    const g = containersCmd();
    const logs = g.commands.find((c) => c.name() === "logs")!;
    const names = optNames(logs);
    expect(names).toContain("--since");
    expect(names).toContain("--search");
    expect(names).toContain("--follow");
    expect(names).toContain("--tail");
  });
});

describe("filterByName", () => {
  const fleet = [
    { name: "api-prod", image: "x" },
    { name: "API-staging", image: "y" },
    { name: "worker", image: "z" },
  ];

  test("returns all entries when substr is undefined/empty", () => {
    expect(filterByName(fleet, undefined)).toHaveLength(3);
    expect(filterByName(fleet, "")).toHaveLength(3);
    expect(filterByName(fleet, "   ")).toHaveLength(3);
  });

  test("matches case-insensitively on a substring", () => {
    expect(filterByName(fleet, "api").map((e) => e.name)).toEqual(["api-prod", "API-staging"]);
    expect(filterByName(fleet, "PROD").map((e) => e.name)).toEqual(["api-prod"]);
  });

  test("returns an empty array when nothing matches", () => {
    expect(filterByName(fleet, "nope")).toEqual([]);
  });

  test("does not mutate the input", () => {
    const copy = [...fleet];
    filterByName(fleet, "api");
    expect(fleet).toEqual(copy);
  });
});
