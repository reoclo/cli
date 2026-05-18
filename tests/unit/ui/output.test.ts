import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { globalOutput, resolveFormat } from "../../../src/ui/output";

test("resolveFormat respects explicit flag", () => {
  expect(resolveFormat("json")).toBe("json");
  expect(resolveFormat("yaml")).toBe("yaml");
  expect(resolveFormat("text")).toBe("text");
});

test("resolveFormat unknown flag falls through", () => {
  // In test runner, isTTY() returns false → defaults to json
  expect(resolveFormat("foo")).toBe("json");
  expect(resolveFormat(undefined)).toBe("json");
});

describe("globalOutput", () => {
  test("returns the --output flag value", () => {
    const p = new Command();
    p.option("-o, --output <fmt>", "fmt", "text");
    p.parse(["node", "x", "-o", "json"]);
    expect(globalOutput(p)).toBe("json");
  });

  test("returns undefined when output is not a string", () => {
    const p = new Command();
    expect(globalOutput(p)).toBeUndefined();
  });
});
