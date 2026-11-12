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
    profile: "work",
    source: "env",
    storeKind: "keyring",
    storeChosen: false,
    setActive: false,
    verbose: false,
  };

  test("env-scoped, not active: profile with source tag + env note, no credentials", () => {
    const out = formatLoginSummary(base);
    expect(out).toContain("✓ authenticated as david@goflowstate.com");
    expect(out).toContain("profile:      work  (from $REOCLO_PROFILE)");
    expect(out).not.toContain("credentials:");
    expect(out).toContain("$REOCLO_PROFILE is set");
    expect(out).toContain("reoclo profile use work");
  });
  test("flag-scoped, not active: --profile tag + flag-specific note", () => {
    const out = formatLoginSummary({ ...base, source: "flag" });
    expect(out).toContain("profile:      work  (from --profile)");
    expect(out).toContain("--profile for this login only");
  });
  const bare: LoginSummaryInput = { ...base, profile: "default", source: "default", setActive: true };

  test("bare login: only the identity line, never an organization", () => {
    expect(formatLoginSummary(bare)).toBe("✓ authenticated as david@goflowstate.com");
  });
  test("--keyring / --no-keyring: credentials line without the profile line", () => {
    const out = formatLoginSummary({ ...bare, storeKind: "file", storeChosen: true });
    expect(out).toContain("credentials:  file");
    expect(out).not.toContain("profile:");
  });
  test("no OS keyring: the file store is reported without a flag", () => {
    const out = formatLoginSummary({ ...bare, storeKind: "file" });
    expect(out).toContain("credentials:  file");
    expect(out).not.toContain("profile:");
  });
  test("--verbose: profile and credentials on a bare login", () => {
    const out = formatLoginSummary({ ...bare, verbose: true });
    expect(out).toContain("profile:      default");
    expect(out).not.toContain("(from");
    expect(out).toContain("credentials:  keyring");
    expect(out).not.toContain("note:");
  });
});
