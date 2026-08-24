import { describe, expect, test } from "bun:test";
import { authSummary, profileRows } from "../../../src/commands/profile";
import type { ProfileRecord } from "../../../src/config/store";

const NOW = Date.parse("2026-01-01T00:00:00Z");

function profile(over: Partial<ProfileRecord> = {}): ProfileRecord {
  return {
    api_url: "https://api.reoclo.com",
    token_type: "tenant",
    tenant_id: "t-1",
    tenant_slug: "acme",
    user_email: "dev@acme.com",
    saved_at: "2025-12-01T00:00:00Z",
    ...over,
  };
}

describe("authSummary", () => {
  test("names an automation key", () => {
    expect(authSummary(profile({ token_type: "automation" }), NOW)).toBe("automation key");
  });

  test("names a plain api key", () => {
    expect(authSummary(profile({ auth_kind: "api-key" }), NOW)).toBe("api key");
  });

  test("reports a live oauth token", () => {
    const p = profile({
      auth_kind: "oauth",
      access_token_expires_at: "2026-01-01T01:00:00Z",
    });
    expect(authSummary(p, NOW)).toBe("oauth");
  });

  test("flags an oauth token past its expiry", () => {
    const p = profile({
      auth_kind: "oauth",
      access_token_expires_at: "2025-12-31T23:00:00Z",
    });
    expect(authSummary(p, NOW)).toBe("oauth (expired)");
  });

  test("falls back to plain oauth when the expiry is missing or unparseable", () => {
    expect(authSummary(profile({ auth_kind: "oauth" }), NOW)).toBe("oauth");
    expect(
      authSummary(profile({ auth_kind: "oauth", access_token_expires_at: "nonsense" }), NOW),
    ).toBe("oauth");
  });

  test("a device-flow login reads as oauth even though its token_type is automation", () => {
    // Real OAuth profiles carry token_type "automation"; auth_kind must win.
    const p = profile({
      token_type: "automation",
      auth_kind: "oauth",
      access_token_expires_at: "2026-01-01T01:00:00Z",
    });
    expect(authSummary(p, NOW)).toBe("oauth");
  });
});

describe("profileRows", () => {
  const profiles: Record<string, ProfileRecord> = {
    staging: profile({ tenant_slug: "acme-staging" }),
    prod: profile({ tenant_slug: "acme" }),
    dev: profile({ tenant_slug: "acme-dev" }),
  };

  test("puts the active profile first, then sorts the rest by name", () => {
    const rows = profileRows(profiles, "staging", NOW);
    expect(rows.map((r) => r.name)).toEqual(["staging", "dev", "prod"]);
  });

  test("marks only the active profile", () => {
    const rows = profileRows(profiles, "prod", NOW);
    expect(rows.filter((r) => r.active === "*").map((r) => r.name)).toEqual(["prod"]);
  });

  test("sorts alphabetically when the active profile is not in the list", () => {
    const rows = profileRows(profiles, "missing", NOW);
    expect(rows.map((r) => r.name)).toEqual(["dev", "prod", "staging"]);
    expect(rows.every((r) => r.active === "")).toBe(true);
  });

  test("carries the fields the table renders", () => {
    const row = profileRows({ prod: profile() }, "prod", NOW)[0]!;
    expect(row).toEqual({
      active: "*",
      name: "prod",
      organization: "acme",
      email: "dev@acme.com",
      auth: "api key",
      api: "https://api.reoclo.com",
    });
  });

  test("handles an empty config", () => {
    expect(profileRows({}, "default", NOW)).toEqual([]);
  });
});
