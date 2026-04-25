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

test("commandSupportedBy: tenant key allows everything", () => {
  expect(commandSupportedBy("domains", "tenant")).toBe(true);
  expect(commandSupportedBy("deploy", "tenant")).toBe(true);
});

test("commandSupportedBy: automation key allows deploy/restart/exec/shell", () => {
  expect(commandSupportedBy("deploy", "automation")).toBe(true);
  expect(commandSupportedBy("restart", "automation")).toBe(true);
  expect(commandSupportedBy("exec", "automation")).toBe(true);
  expect(commandSupportedBy("shell", "automation")).toBe(true);
  expect(commandSupportedBy("domains", "automation")).toBe(false);
  expect(commandSupportedBy("env", "automation")).toBe(false);
});
