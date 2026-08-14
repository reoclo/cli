import { test, expect } from "bun:test";
import { Command } from "commander";
import { registerSkills } from "../../../src/commands/skills";

test("registerSkills adds an install and a list subcommand", () => {
  const program = new Command();
  registerSkills(program);
  const skills = program.commands.find((c) => c.name() === "skills");
  expect(skills).toBeDefined();
  const subs = skills!.commands.map((c) => c.name()).sort();
  expect(subs).toEqual(["install", "list"]);
});
