import { describe, expect, test } from "bun:test";
import { buildProjectBinding, parseSkillsOption } from "../../../src/commands/init";

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

describe("buildProjectBinding", () => {
  test("writes only the org (+ version) when resolved under the active profile", () => {
    expect(buildProjectBinding({ org: "acme", profileName: "default", activeProfile: "default" })).toEqual(
      { org: "acme", version: 1 },
    );
  });

  test("records the profile when the org was resolved under a NON-active profile", () => {
    // The org slug is only meaningful relative to its backend, so a project
    // initialized under --profile staging must pin staging or it will silently
    // re-resolve against the active profile later.
    expect(
      buildProjectBinding({ org: "platform", profileName: "staging", activeProfile: "default" }),
    ).toEqual({ profile: "staging", org: "platform", version: 1 });
  });

  test("orders profile before org for readability", () => {
    expect(
      Object.keys(buildProjectBinding({ org: "platform", profileName: "staging", activeProfile: "default" })),
    ).toEqual(["profile", "org", "version"]);
  });

  test("includes the skills block when skills were installed", () => {
    expect(
      buildProjectBinding({
        org: "acme",
        profileName: "default",
        activeProfile: "default",
        skills: { ref: "main", sha: "deadbeef", installed_at: "2026-08-01T00:00:00.000Z" },
      }),
    ).toEqual({
      org: "acme",
      version: 1,
      skills: { ref: "main", sha: "deadbeef", installed_at: "2026-08-01T00:00:00.000Z" },
    });
  });
});
