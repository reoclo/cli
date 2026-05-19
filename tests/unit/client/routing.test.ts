import { expect, test } from "bun:test";
import { detectKeyType, apiPrefix, commandSupportedBy } from "../../../src/client/routing";

test("rk_t_ → tenant", () => {
  expect(detectKeyType("rk_t_xyz")).toBe("tenant");
});

test("rk_a_ → automation", () => {
  expect(detectKeyType("rk_a_xyz")).toBe("automation");
});

test("unknown prefix → tenant (fallback)", () => {
  expect(detectKeyType("rk_foo")).toBe("tenant");
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

  test("automation keys reject containers restart (leaf-name collision fix)", () => {
    expect(commandSupportedBy("containers restart", "automation")).toBe(false);
  });

  test("automation keys reject unrelated commands", () => {
    expect(commandSupportedBy("servers ls", "automation")).toBe(false);
    expect(commandSupportedBy("schedule trigger", "automation")).toBe(false);
  });
});
