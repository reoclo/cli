import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { requireCapability } from "../../src/client/command-meta";
import { filterCommandsByCapability } from "../../src/client/help-filter";

describe("filterCommandsByCapability", () => {
  test("hides tagged commands when the capability is missing", () => {
    const root = new Command("root");
    const visible = root.command("ungated");
    const gated = root.command("gated");
    requireCapability(gated, "container:exec");

    filterCommandsByCapability(root, ["container:read"]);

    // Commander's hidden flag controls --help visibility.
    expect(visible.options).toBeDefined();
    expect((visible as unknown as { _hidden?: boolean })._hidden ?? false).toBe(false);
    expect((gated as unknown as { _hidden?: boolean })._hidden).toBe(true);
  });

  test("shows tagged commands when the capability is granted", () => {
    const root = new Command("root");
    const gated = root.command("gated");
    requireCapability(gated, "container:exec");

    filterCommandsByCapability(root, ["container:exec", "container:read"]);

    expect((gated as unknown as { _hidden?: boolean })._hidden ?? false).toBe(false);
  });

  test("recurses into subcommands", () => {
    const root = new Command("root");
    const sub = root.command("sub");
    const inner = sub.command("inner");
    requireCapability(inner, "app:deploy");

    filterCommandsByCapability(root, []);

    expect((inner as unknown as { _hidden?: boolean })._hidden).toBe(true);
  });

  test("treats undefined capabilities as 'show only ungated'", () => {
    const root = new Command("root");
    const ungated = root.command("ungated");
    const gated = root.command("gated");
    requireCapability(gated, "container:exec");

    filterCommandsByCapability(root, undefined);

    expect((ungated as unknown as { _hidden?: boolean })._hidden ?? false).toBe(false);
    expect((gated as unknown as { _hidden?: boolean })._hidden).toBe(true);
  });
});
