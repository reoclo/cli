import { test, expect } from "bun:test";
import { Command } from "commander";
import { registerSkills } from "../../../src/commands/skills";

test("registerSkills adds install, list, and update subcommands", () => {
  const program = new Command();
  registerSkills(program);
  const skills = program.commands.find((c) => c.name() === "skills");
  expect(skills).toBeDefined();
  const subs = skills!.commands.map((c) => c.name()).sort();
  expect(subs).toEqual(["install", "list", "update"]);
});

test("registerSkills exposes `init` as an alias of install", () => {
  const program = new Command();
  registerSkills(program);
  const skills = program.commands.find((c) => c.name() === "skills");
  const install = skills!.commands.find((c) => c.name() === "install");
  expect(install!.aliases()).toContain("init");
});
