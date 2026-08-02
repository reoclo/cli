import { describe, expect, test } from "bun:test";
import { effectiveOrg, orgSelectionError, resolveOrgOverride } from "../../../src/config/org-resolve";

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
    expect(effectiveOrg({ flagOrg: "flagco" })).toEqual({
      org: "flagco",
      source: "flag",
    });
  });

  test("reports the env as the source when no flag", () => {
    expect(effectiveOrg({ envOrg: "envco" })).toEqual({
      org: "envco",
      source: "env",
    });
  });

  test("reports .reoclo as the source when only projectOrg is set", () => {
    expect(effectiveOrg({ projectOrg: "proj" })).toEqual({
      org: "proj",
      source: "reoclo",
    });
  });

  test("flag beats env and projectOrg", () => {
    expect(effectiveOrg({ flagOrg: "flagco", envOrg: "envco", projectOrg: "proj" })).toEqual({
      org: "flagco",
      source: "flag",
    });
  });

  test("env beats projectOrg", () => {
    expect(effectiveOrg({ envOrg: "envco", projectOrg: "proj" })).toEqual({
      org: "envco",
      source: "env",
    });
  });

  test("reports 'none' with an empty org when nothing selects one", () => {
    expect(effectiveOrg({})).toEqual({
      org: "",
      source: "none",
    });
  });

  test("blank overrides are treated as unset, reporting 'none'", () => {
    expect(effectiveOrg({ flagOrg: "  ", envOrg: "", projectOrg: "   " })).toEqual({
      org: "",
      source: "none",
    });
  });
});

test("orgSelectionError: OAuth profile with no override is rejected", () => {
  const err = orgSelectionError({ orgRequired: true, orgOverride: undefined, authKind: "oauth" });
  expect(err).not.toBeNull();
  expect(err!.exitCode).toBe(4);
  expect(err!.message).toContain("No organization selected");
});

test("orgSelectionError: override present → no error", () => {
  expect(orgSelectionError({ orgRequired: true, orgOverride: "acme", authKind: "oauth" })).toBeNull();
});

test("orgSelectionError: automation/api-key credential is exempt", () => {
  expect(orgSelectionError({ orgRequired: true, orgOverride: undefined, authKind: undefined })).toBeNull();
  expect(orgSelectionError({ orgRequired: true, orgOverride: undefined, authKind: "api-key" })).toBeNull();
});

test("orgSelectionError: orgRequired=false → no error", () => {
  expect(orgSelectionError({ orgRequired: false, orgOverride: undefined, authKind: "oauth" })).toBeNull();
});
