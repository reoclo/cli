import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { applyVerbAliases } from "../../../src/lib/verb-aliases";
import { registerDomains } from "../../../src/commands/domains";
import { registerChannels } from "../../../src/commands/channels";
import { registerAlerts } from "../../../src/commands/alerts";
import { registerStatusPages } from "../../../src/commands/status-pages";

function find(root: Command, path: string[]): Command {
  let cmd = root;
  for (const name of path) {
    const next = cmd.commands.find((c) => c.name() === name);
    if (!next) throw new Error(`no command '${name}' under '${cmd.name()}'`);
    cmd = next;
  }
  return cmd;
}

describe("applyVerbAliases", () => {
  test("ls answers to list, and list answers to ls", () => {
    const root = new Command();
    root.command("things").command("ls");
    root.command("others").command("list");
    applyVerbAliases(root);

    expect(find(root, ["things", "ls"]).aliases()).toEqual(["list"]);
    expect(find(root, ["others", "list"]).aliases()).toEqual(["ls"]);
  });

  test("rm answers to both delete and remove", () => {
    const root = new Command();
    root.command("things").command("rm");
    applyVerbAliases(root);
    expect(find(root, ["things", "rm"]).aliases().sort()).toEqual(["delete", "remove"]);
  });

  test("applies at every depth, not just the top level", () => {
    const root = new Command();
    const group = root.command("alerts");
    group.command("mutes").command("ls");
    applyVerbAliases(root);
    expect(find(root, ["alerts", "mutes", "ls"]).aliases()).toEqual(["list"]);
  });

  test("a real sibling command always beats a generated alias", () => {
    const root = new Command();
    const group = root.command("things");
    group.command("ls");
    group.command("list"); // already exists — 'ls' must not claim the name
    applyVerbAliases(root);

    expect(find(root, ["things", "ls"]).aliases()).toEqual([]);
    expect(find(root, ["things", "list"]).aliases()).toEqual([]);
  });

  test("does not clobber an alias a command was given deliberately", () => {
    const root = new Command();
    const group = root.command("skills");
    group.command("install").alias("list"); // contrived, but must win
    group.command("ls");
    applyVerbAliases(root);
    expect(find(root, ["skills", "ls"]).aliases()).toEqual([]);
  });

  test("is idempotent — a second pass adds nothing", () => {
    const root = new Command();
    root.command("things").command("ls");
    expect(applyVerbAliases(root)).toBe(1);
    expect(applyVerbAliases(root)).toBe(0);
    expect(find(root, ["things", "ls"]).aliases()).toEqual(["list"]);
  });

  test("leaves commands with no equivalent spelling alone", () => {
    const root = new Command();
    const group = root.command("things");
    group.command("get");
    group.command("create");
    expect(applyVerbAliases(root)).toBe(0);
  });
});

describe("applyVerbAliases over real command groups", () => {
  function realProgram(): Command {
    const program = new Command();
    registerDomains(program);
    registerChannels(program);
    registerAlerts(program);
    registerStatusPages(program);
    applyVerbAliases(program);
    return program;
  }

  test("groups spelled 'ls' also answer to 'list'", () => {
    const program = realProgram();
    expect(find(program, ["domains", "ls"]).aliases()).toContain("list");
    expect(find(program, ["status-pages", "ls"]).aliases()).toContain("list");
    expect(find(program, ["status-pages", "components", "ls"]).aliases()).toContain("list");
    expect(find(program, ["alerts", "catalog", "ls"]).aliases()).toContain("list");
  });

  test("groups spelled 'list' also answer to 'ls'", () => {
    const program = realProgram();
    expect(find(program, ["channels", "list"]).aliases()).toContain("ls");
    expect(find(program, ["alerts", "list"]).aliases()).toContain("ls");
    expect(find(program, ["alerts", "mutes", "list"]).aliases()).toContain("ls");
  });

  test("destructive verbs line up too", () => {
    const program = realProgram();
    expect(find(program, ["domains", "rm"]).aliases()).toContain("delete");
    expect(find(program, ["channels", "delete"]).aliases()).toContain("rm");
  });

  test("every collection command answers to both spellings", () => {
    const program = realProgram();
    const offenders: string[] = [];
    const walk = (cmd: Command, path: string[]): void => {
      for (const child of cmd.commands) {
        const names = [child.name(), ...child.aliases()];
        if (names.includes("ls") || names.includes("list")) {
          if (!names.includes("ls") || !names.includes("list")) {
            offenders.push([...path, child.name()].join(" "));
          }
        }
        walk(child, [...path, child.name()]);
      }
    };
    walk(program, []);
    expect(offenders).toEqual([]);
  });
});
