import { describe, expect, test } from "bun:test";
import {
  shouldSetActiveProfile,
  formatLoginSummary,
  type LoginSummaryInput,
} from "../../../src/commands/login-summary";

describe("shouldSetActiveProfile", () => {
  test("first profile on the machine → true regardless of source", () => {
    expect(shouldSetActiveProfile({ hadNoProfiles: true, source: "env" })).toBe(true);
    expect(shouldSetActiveProfile({ hadNoProfiles: true, source: "flag" })).toBe(true);
    expect(shouldSetActiveProfile({ hadNoProfiles: true, source: "default" })).toBe(true);
  });
  test("bare login (source default) → true", () => {
    expect(shouldSetActiveProfile({ hadNoProfiles: false, source: "default" })).toBe(true);
  });
  test("scoped login with existing profiles → false", () => {
    expect(shouldSetActiveProfile({ hadNoProfiles: false, source: "env" })).toBe(false);
    expect(shouldSetActiveProfile({ hadNoProfiles: false, source: "flag" })).toBe(false);
  });
});

describe("formatLoginSummary", () => {
  const base: LoginSummaryInput = {
    email: "david@goflowstate.com",
    org: "acme",
    roles: ["tenant_admin"],
    profile: "work",
    source: "env",
    storeKind: "keyring",
    setActive: false,
  };

  test("env-scoped, not active: source tag + prettified role + env note", () => {
    const out = formatLoginSummary(base);
    expect(out).toContain("✓ authenticated as david@goflowstate.com");
    expect(out).toContain("organization: acme");
    expect(out).toContain("role:         Tenant Admin");
    expect(out).toContain("profile:      work  (from $REOCLO_PROFILE)");
    expect(out).toContain("credentials:  keyring");
    expect(out).toContain("$REOCLO_PROFILE is set");
    expect(out).toContain("reoclo profile use work");
  });
  test("flag-scoped, not active: --profile tag + flag-specific note", () => {
    const out = formatLoginSummary({ ...base, source: "flag" });
    expect(out).toContain("profile:      work  (from --profile)");
    expect(out).toContain("--profile for this login only");
  });
  test("bare login, active: no source tag, no note", () => {
    const out = formatLoginSummary({
      ...base,
      profile: "default",
      source: "default",
      setActive: true,
    });
    expect(out).toContain("profile:      default");
    expect(out).not.toContain("(from");
    expect(out).not.toContain("note:");
  });
  test("omits the role line when roles is empty", () => {
    const out = formatLoginSummary({ ...base, roles: [], setActive: true });
    expect(out).not.toContain("role:");
  });
  test("joins multiple roles, prettified", () => {
    const out = formatLoginSummary({
      ...base,
      roles: ["tenant_admin", "viewer"],
      setActive: true,
    });
    expect(out).toContain("role:         Tenant Admin, Viewer");
  });
});
