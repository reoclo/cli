import { describe, expect, test } from "bun:test";
import {
  refreshTokenKey,
  refreshTokenKeyCandidates,
  resolveStore,
  storeForProfile,
  withKeyringStore,
} from "../../../src/config/token-store";
import { MemoryStore } from "../../../src/config/keyring/memory";

function withCI<T>(fn: () => Promise<T>): Promise<T> {
  process.env.CI = "1";
  return fn().finally(() => {
    delete process.env.CI;
  });
}

describe("storeForProfile", () => {
  const keyring = new MemoryStore();

  test("a config-file profile reads from config.json", async () => {
    const store = await withKeyringStore(keyring, () => storeForProfile({}, "default"));
    expect(store.kind).toBe("file");
  });

  test("a keyring profile reads from the keyring even under CI", async () => {
    const store = await withCI(() =>
      withKeyringStore(keyring, () =>
        storeForProfile({ token_ref: "keyring:reoclo-default" }, "default"),
      ),
    );
    expect(store).toBe(keyring);
  });

  test("a refresh token alone also means the keyring", async () => {
    const store = await withKeyringStore(keyring, () =>
      storeForProfile({ refresh_token_ref: "default-refresh" }, "default"),
    );
    expect(store).toBe(keyring);
  });

  test("a keyring profile on a machine with no keyring falls back to config.json", async () => {
    const store = await withKeyringStore(null, () =>
      storeForProfile({ token_ref: "keyring:reoclo-default" }, "default"),
    );
    expect(store.kind).toBe("file");
  });

  test("new logins under CI still go to config.json", async () => {
    const store = await withCI(() => withKeyringStore(keyring, () => resolveStore()));
    expect(store.kind).toBe("file");
  });
});

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
