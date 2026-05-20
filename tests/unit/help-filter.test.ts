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

  test("recurses into subcommands when caps are known", () => {
    const root = new Command("root");
    const sub = root.command("sub");
    const inner = sub.command("inner");
    requireCapability(inner, "app:deploy");

    // Pass a non-empty cap list that doesn't include "app:deploy" so the gate fires.
    filterCommandsByCapability(root, ["something:else"]);

    expect((inner as unknown as { _hidden?: boolean })._hidden).toBe(true);
  });

  test("treats undefined or empty capabilities as 'unknown — show everything'", () => {
    // Rationale: when the local cap cache hasn't been populated (OAuth profile
    // that never fetched, /auth/me/capabilities returned 404, etc.) we want the
    // user to still discover commands and let the server enforce.
    const undef = new Command("root");
    const undefGated = undef.command("gated");
    requireCapability(undefGated, "container:exec");
    filterCommandsByCapability(undef, undefined);
    expect((undefGated as unknown as { _hidden?: boolean })._hidden ?? false).toBe(false);

    const empty = new Command("root");
    const emptyGated = empty.command("gated");
    requireCapability(emptyGated, "container:exec");
    filterCommandsByCapability(empty, []);
    expect((emptyGated as unknown as { _hidden?: boolean })._hidden ?? false).toBe(false);
  });
});
