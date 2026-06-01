import { describe, expect, test } from "bun:test";
import { refreshTokenKey, refreshTokenKeyCandidates } from "../../../src/config/token-store";

describe("refreshTokenKey", () => {
  test("derives the keyring key from the bare profile name (matches the access-token key scheme)", () => {
    expect(refreshTokenKey("staging")).toBe("staging-refresh");
    expect(refreshTokenKey("default")).toBe("default-refresh");
  });
});

describe("refreshTokenKeyCandidates", () => {
  test("tries the derived key first, then a differing legacy ref", () => {
    // Regression guard: login writes the refresh token to `${profile}-refresh`,
    // but configs written 2026-05-22..0.38.0 recorded
    // `refresh_token_ref: reoclo-<profile>-refresh`. Reads must try the derived
    // key first so they find the token where login actually stored it; the
    // legacy ref is kept as a fallback so nothing regresses.
    expect(refreshTokenKeyCandidates("staging", "reoclo-staging-refresh")).toEqual([
      "staging-refresh",
      "reoclo-staging-refresh",
    ]);
  });

  test("dedupes when the legacy ref already equals the derived key", () => {
    expect(refreshTokenKeyCandidates("staging", "staging-refresh")).toEqual(["staging-refresh"]);
  });

  test("omits an absent legacy ref", () => {
    expect(refreshTokenKeyCandidates("default")).toEqual(["default-refresh"]);
    expect(refreshTokenKeyCandidates("default", undefined)).toEqual(["default-refresh"]);
  });
});
