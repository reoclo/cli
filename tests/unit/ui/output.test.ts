import { expect, test } from "bun:test";
import { resolveFormat } from "../../../src/ui/output";

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
