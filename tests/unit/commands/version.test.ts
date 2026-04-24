// tests/unit/commands/version.test.ts
import { expect, test } from "bun:test";
import pkg from "../../../package.json" with { type: "json" };

test("VERSION exported from index matches package.json", async () => {
  const mod = await import("../../../src/index.ts");
  expect(mod.VERSION).toBe(pkg.version);
});
