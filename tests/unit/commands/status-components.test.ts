import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerStatusPages } from "../../../src/commands/status-pages";
import { findComponent, type StatusComponent } from "../../../src/commands/status-components";

function componentsCmd(): Command {
  const p = new Command();
  const g = registerStatusPages(p);
  return g.commands.find((c) => c.name() === "components")!;
}

function sub(name: string): Command {
  const found = componentsCmd().commands.find((c) => c.name() === name);
  if (!found) throw new Error(`no 'status-pages components ${name}' subcommand`);
  return found;
}

function component(over: Partial<StatusComponent>): StatusComponent {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    status_page_id: "page-1",
    name: "API",
    position: 0,
    is_visible: true,
    source: { kind: "manual", ref_id: null },
    health_check: {
      enabled: false,
      url: null,
      interval_seconds: 60,
      expected_status_min: 200,
      expected_status_max: 299,
      timeout_seconds: 10,
    },
    override: {
      enabled: false,
      status: null,
      reason: null,
      suppress_auto_incidents: true,
      until: null,
    },
    auto_incident: {
      enabled: true,
      open_after_consecutive_failures: 3,
      resolve_after_consecutive_successes: 2,
    },
    state: { effective_status: "operational", source_status: "operational", source_missing: false },
    ...over,
  };
}

describe("reoclo status-pages components", () => {
  test("registers the full component lifecycle", () => {
    const names = componentsCmd().commands.map((c) => c.name());
    expect(names.sort()).toEqual(
      ["add", "get", "ls", "pin", "reorder", "rm", "unpin", "update"].sort(),
    );
  });

  test("every subcommand takes the page as its first argument", () => {
    for (const cmd of componentsCmd().commands) {
      const first = cmd.registeredArguments[0];
      expect(first?.name()).toBe("page");
    }
  });

  test("add requires --name and offers source, health, and incident flags", () => {
    const add = sub("add");
    const flags = add.options.map((o) => o.long);
    expect(add.options.find((o) => o.long === "--name")!.mandatory).toBe(true);
    for (const f of [
      "--source",
      "--ref",
      "--position",
      "--hidden",
      "--health-url",
      "--health-interval",
      "--expect-status",
      "--health-timeout",
      "--auto-incident",
      "--open-after",
      "--resolve-after",
    ]) {
      expect(flags).toContain(f);
    }
  });

  test("update has no required options — every field is optional", () => {
    expect(sub("update").options.every((o) => !o.mandatory)).toBe(true);
  });

  test("pin requires --status", () => {
    const pin = sub("pin");
    expect(pin.options.find((o) => o.long === "--status")!.mandatory).toBe(true);
    const flags = pin.options.map((o) => o.long);
    expect(flags).toContain("--reason");
    expect(flags).toContain("--until");
    expect(flags).toContain("--allow-incidents");
  });

  test("reorder takes a variadic list of components", () => {
    const args = sub("reorder").registeredArguments;
    expect(args.map((a) => a.name())).toEqual(["page", "components"]);
    expect(args[1]!.variadic).toBe(true);
  });

  test("rm has --yes so it can run non-interactively", () => {
    expect(sub("rm").options.map((o) => o.long)).toContain("--yes");
  });
});

describe("findComponent", () => {
  const list = [
    component({ id: "id-a", name: "API" }),
    component({ id: "id-b", name: "Web Dashboard" }),
  ];

  test("matches on id", () => {
    expect(findComponent(list, "id-b")?.name).toBe("Web Dashboard");
  });

  test("matches on name, ignoring case", () => {
    expect(findComponent(list, "web dashboard")?.id).toBe("id-b");
  });

  test("prefers an id match over a name match", () => {
    const ambiguous = [component({ id: "API", name: "Something Else" }), ...list];
    expect(findComponent(ambiguous, "API")?.name).toBe("Something Else");
  });

  test("returns null when nothing matches", () => {
    expect(findComponent(list, "nope")).toBeNull();
  });
});
