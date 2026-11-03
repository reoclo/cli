import { describe, expect, test } from "bun:test";
import { SUBMODULE_MODES, parseSubmodules, withSubmodules } from "../../../src/util/submodules";

describe("parseSubmodules", () => {
  test("accepts the three modes, ignoring case and spaces", () => {
    expect(SUBMODULE_MODES).toEqual(["off", "on", "recursive"]);
    expect(parseSubmodules("off")).toBe("off");
    expect(parseSubmodules(" On ")).toBe("on");
    expect(parseSubmodules("RECURSIVE")).toBe("recursive");
  });

  test("rejects anything else with exit code 2, naming the flag and the three values", () => {
    for (const bad of ["true", "all", "", "recurse"]) {
      let caught: (Error & { exitCode?: number }) | undefined;
      try {
        parseSubmodules(bad);
      } catch (e) {
        caught = e as Error & { exitCode?: number };
      }
      expect(caught?.exitCode).toBe(2);
      expect(caught?.message).toContain("--submodules");
      expect(caught?.message).toContain("off, on, recursive");
    }
  });
});

describe("withSubmodules", () => {
  test("fills in off when the field is absent, null or empty", () => {
    expect(withSubmodules({ id: "a" })).toEqual({ id: "a", submodules: "off" });
    expect(withSubmodules({ submodules: null })).toEqual({ submodules: "off" });
    expect(withSubmodules({ submodules: "" })).toEqual({ submodules: "off" });
  });

  test("keeps a mode the API returned and does not mutate the input", () => {
    const input = { id: "a", submodules: "recursive" };
    expect(withSubmodules(input)).toEqual({ id: "a", submodules: "recursive" });
    const bare = { id: "b" };
    withSubmodules(bare);
    expect(bare).toEqual({ id: "b" });
  });
});
