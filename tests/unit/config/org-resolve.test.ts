import { describe, expect, test } from "bun:test";
import { effectiveOrg, resolveOrgOverride } from "../../../src/config/org-resolve";

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

  test("projectOrg is used when flag and env are absent", () => {
    expect(resolveOrgOverride({ projectOrg: "acme" })).toBe("acme");
  });

  test("flag beats projectOrg", () => {
    expect(resolveOrgOverride({ flagOrg: "flagco", projectOrg: "proj" })).toBe("flagco");
  });

  test("env beats projectOrg", () => {
    expect(resolveOrgOverride({ envOrg: "envco", projectOrg: "proj" })).toBe("envco");
  });

  test("blank/whitespace env falls through to projectOrg", () => {
    expect(resolveOrgOverride({ envOrg: "   ", projectOrg: "acme" })).toBe("acme");
  });

  test("blank projectOrg is treated as unset", () => {
    expect(resolveOrgOverride({ projectOrg: "   " })).toBeUndefined();
  });

  test("projectOrg surrounding whitespace is trimmed", () => {
    expect(resolveOrgOverride({ projectOrg: "  acme  " })).toBe("acme");
  });
});

describe("effectiveOrg", () => {
  test("reports the flag as the source when set", () => {
    expect(effectiveOrg({ flagOrg: "flagco", profileOrg: "home" })).toEqual({
      org: "flagco",
      source: "flag",
    });
  });

  test("reports the env as the source when no flag", () => {
    expect(effectiveOrg({ envOrg: "envco", profileOrg: "home" })).toEqual({
      org: "envco",
      source: "env",
    });
  });

  test("reports .reoclo as the source when only projectOrg is set", () => {
    expect(effectiveOrg({ projectOrg: "proj", profileOrg: "home" })).toEqual({
      org: "proj",
      source: "reoclo",
    });
  });

  test("falls back to the profile org with source 'active'", () => {
    expect(effectiveOrg({ profileOrg: "home" })).toEqual({
      org: "home",
      source: "active",
    });
  });

  test("blank overrides fall through to the profile org", () => {
    expect(effectiveOrg({ flagOrg: "  ", envOrg: "", profileOrg: "home" })).toEqual({
      org: "home",
      source: "active",
    });
  });
});
