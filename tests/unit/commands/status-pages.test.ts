import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerStatusPages } from "../../../src/commands/status-pages";

function spCmd(): Command {
  const p = new Command();
  registerStatusPages(p);
  return p.commands.find((c) => c.name() === "status-pages")!;
}

function sub(name: string): Command {
  const found = spCmd().commands.find((c) => c.name() === name);
  if (!found) throw new Error(`no 'status-pages ${name}' subcommand`);
  return found;
}

describe("reoclo status-pages", () => {
  test("registers all subcommands", () => {
    const names = spCmd().commands.map((c) => c.name());
    expect(names.sort()).toEqual(
      [
        "components",
        "create",
        "get",
        "link",
        "ls",
        "publish",
        "regenerate-slug",
        "rm",
        "unlink",
        "unpublish",
        "update",
      ].sort(),
    );
  });

  test("registerStatusPages returns the group so callers can extend it", () => {
    const p = new Command();
    const returned = registerStatusPages(p);
    expect(returned.name()).toBe("status-pages");
    expect(returned).toBe(p.commands.find((c) => c.name() === "status-pages")!);
  });

  test("create takes page fields plus one-shot domain linking, none required", () => {
    const create = sub("create");
    const flags = create.options.map((o) => o.long);
    expect(flags).toContain("--title");
    expect(flags).toContain("--label");
    expect(flags).toContain("--description");
    expect(flags).toContain("--hostname");
    expect(flags).toContain("--verified-domain");
    expect(create.options.every((o) => !o.mandatory)).toBe(true);
  });

  test("update has --title/--label/--description/--published", () => {
    const flags = sub("update").options.map((o) => o.long);
    expect(flags).toContain("--title");
    expect(flags).toContain("--label");
    expect(flags).toContain("--description");
    expect(flags).toContain("--published");
  });

  test("link requires --hostname and infers the root domain by default", () => {
    const link = sub("link");
    const hostname = link.options.find((o) => o.long === "--hostname")!;
    const verified = link.options.find((o) => o.long === "--verified-domain")!;
    expect(hostname.mandatory).toBe(true);
    expect(verified.mandatory).toBe(false);
  });

  test("publish and unpublish take just the page", () => {
    for (const name of ["publish", "unpublish", "unlink"]) {
      expect(sub(name).options.length).toBe(0);
    }
  });
});
