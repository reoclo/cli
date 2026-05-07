import { describe, expect, test } from "bun:test";
import { hasCapability } from "../../src/client/capabilities";

describe("hasCapability", () => {
  test("returns true when verb is in the list", () => {
    expect(hasCapability(["container:exec", "container:read"], "container:exec")).toBe(true);
  });

  test("returns false when verb is missing", () => {
    expect(hasCapability(["container:read"], "container:exec")).toBe(false);
  });

  test("returns false on empty list", () => {
    expect(hasCapability([], "container:exec")).toBe(false);
  });

  test("returns false on undefined list (legacy profile)", () => {
    expect(hasCapability(undefined, "container:exec")).toBe(false);
  });
});

// fetchCapabilities tested via integration in login.test.ts
