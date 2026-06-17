import { describe, expect, test } from "bun:test";
import { parseSkillsOption } from "../../../src/commands/init";

describe("parseSkillsOption", () => {
  test("--no-skills (false) skips", () => {
    expect(parseSkillsOption(false)).toEqual({ skip: true });
  });

  test("absent (undefined) installs all", () => {
    expect(parseSkillsOption(undefined)).toEqual({ skip: false });
  });

  test("the default-true form (no negation) installs all", () => {
    expect(parseSkillsOption(true)).toEqual({ skip: false });
  });

  test("a comma list selects a subset", () => {
    expect(parseSkillsOption("a,b")).toEqual({ skip: false, requested: ["a", "b"] });
  });

  test("trims and drops empty entries in the list", () => {
    expect(parseSkillsOption("a, b ,")).toEqual({ skip: false, requested: ["a", "b"] });
  });
});
