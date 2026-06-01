import { describe, expect, test } from "bun:test";
import { resolveOrgOverride } from "../../../src/config/org-resolve";

describe("resolveOrgOverride", () => {
  test("flag wins over env", () => {
    expect(resolveOrgOverride({ flagOrg: "acme", envOrg: "other" })).toBe("acme");
  });

  test("env is used when no flag is given", () => {
    expect(resolveOrgOverride({ envOrg: "acme" })).toBe("acme");
  });

  test("undefined when neither is set", () => {
    expect(resolveOrgOverride({})).toBeUndefined();
  });

  test("blank/whitespace flag falls through to env", () => {
    expect(resolveOrgOverride({ flagOrg: "   ", envOrg: "acme" })).toBe("acme");
  });

  test("blank env is treated as unset", () => {
    expect(resolveOrgOverride({ envOrg: "   " })).toBeUndefined();
  });

  test("trims surrounding whitespace", () => {
    expect(resolveOrgOverride({ flagOrg: "  acme  " })).toBe("acme");
  });
});
