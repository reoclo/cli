import { expect, test } from "bun:test";
import {
  detectKeyType,
  apiPrefix,
  commandSupportedBy,
  automationAllowedCommands,
} from "../../../src/client/routing";

test("rk_a_ → automation", () => {
  expect(detectKeyType("rk_a_xyz")).toBe("automation");
});

test("rca_ → automation", () => {
  expect(detectKeyType("rca_xyz")).toBe("automation");
});

test("OAuth bearer / unknown prefix → tenant routing (fallback)", () => {
  expect(detectKeyType("rk_foo")).toBe("tenant");
  expect(detectKeyType("eyJhbGciOiJSUzI1NiJ9.fake.jwt")).toBe("tenant");
});

test("apiPrefix automation", () => {
  expect(apiPrefix("automation")).toBe("/api/automation/v1");
});

test("apiPrefix tenant", () => {
  expect(apiPrefix("tenant")).toBe("/mcp");
});

import { describe } from "bun:test";

describe("commandSupportedBy", () => {
  test("tenant keys support everything", () => {
    expect(commandSupportedBy("apps deploy", "tenant")).toBe(true);
    expect(commandSupportedBy("containers restart", "tenant")).toBe(true);
    expect(commandSupportedBy("anything", "tenant")).toBe(true);
  });

  test("automation keys support apps deploy/restart, exec, and shell", () => {
    expect(commandSupportedBy("apps deploy", "automation")).toBe(true);
    expect(commandSupportedBy("apps restart", "automation")).toBe(true);
    expect(commandSupportedBy("exec", "automation")).toBe(true);
    expect(commandSupportedBy("shell", "automation")).toBe(true);
  });

  test("automation keys support the CI commands (checkout, registry login/logout)", () => {
    expect(commandSupportedBy("checkout", "automation")).toBe(true);
    expect(commandSupportedBy("registry login", "automation")).toBe(true);
    expect(commandSupportedBy("registry logout", "automation")).toBe(true);
  });

  test("automation keys reject containers restart (leaf-name collision fix)", () => {
    expect(commandSupportedBy("containers restart", "automation")).toBe(false);
  });

  test("automation keys reject unrelated commands", () => {
    expect(commandSupportedBy("servers ls", "automation")).toBe(false);
    expect(commandSupportedBy("schedule trigger", "automation")).toBe(false);
  });
});

describe("automationAllowedCommands", () => {
  // The rejection message in index.ts used to restate this list by hand, and it
  // drifted: it omitted `run`, so an operator was told the one command that
  // reads secrets with an automation key was unavailable to automation keys.
  test("every listed command is actually accepted", () => {
    for (const cmd of automationAllowedCommands()) {
      expect(commandSupportedBy(cmd, "automation")).toBe(true);
    }
  });

  test("includes run, the only command that reads secrets", () => {
    expect(automationAllowedCommands()).toContain("run");
  });

  test("returns a copy, so a caller cannot mutate the allowlist", () => {
    automationAllowedCommands().push("servers rm");
    expect(commandSupportedBy("servers rm", "automation")).toBe(false);
  });
});
