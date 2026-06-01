import { describe, expect, test } from "bun:test";
import { extractProfileFromArgv, resolveProfileName } from "../../../src/config/profile-resolve";

describe("extractProfileFromArgv", () => {
  test("returns undefined when --profile is absent", () => {
    expect(extractProfileFromArgv(["bun", "index.ts", "servers", "ls"])).toBeUndefined();
  });

  test("reads `--profile <name>`", () => {
    expect(
      extractProfileFromArgv(["bun", "index.ts", "--profile", "staging", "servers", "ls"]),
    ).toBe("staging");
  });

  test("reads `--profile=<name>`", () => {
    expect(extractProfileFromArgv(["--profile=prod", "apps", "ls"])).toBe("prod");
  });

  test("reads --profile placed after the subcommand", () => {
    expect(extractProfileFromArgv(["servers", "ls", "--profile", "staging"])).toBe("staging");
  });

  test("returns undefined for a dangling --profile with no value", () => {
    expect(extractProfileFromArgv(["servers", "ls", "--profile"])).toBeUndefined();
  });

  test("does not consume a following flag as the value", () => {
    expect(extractProfileFromArgv(["--profile", "-o", "json"])).toBeUndefined();
  });

  test("treats an empty `--profile=` as undefined", () => {
    expect(extractProfileFromArgv(["--profile="])).toBeUndefined();
  });

  test("returns the first --profile when repeated", () => {
    expect(extractProfileFromArgv(["--profile", "a", "--profile", "b"])).toBe("a");
  });
});

describe("resolveProfileName", () => {
  const activeProfile = "default";

  test("flag wins over env and active", () => {
    expect(resolveProfileName({ flagProfile: "flagp", envProfile: "envp", activeProfile })).toBe(
      "flagp",
    );
  });

  test("env wins over active when no flag", () => {
    expect(resolveProfileName({ envProfile: "envp", activeProfile })).toBe("envp");
  });

  test("falls back to the active profile", () => {
    expect(resolveProfileName({ activeProfile })).toBe("default");
  });

  test("treats empty / whitespace flag and env as unset", () => {
    expect(resolveProfileName({ flagProfile: "  ", envProfile: "", activeProfile })).toBe("default");
  });

  test("trims surrounding whitespace on the chosen value", () => {
    expect(resolveProfileName({ flagProfile: " staging ", activeProfile })).toBe("staging");
  });
});
