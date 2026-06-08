import { describe, expect, test } from "bun:test";
import { refreshSession, singleFlightRefresh } from "../../../src/auth/refresh";
import { ReauthRequiredError } from "../../../src/client/errors";
import { LockTimeoutError } from "../../../src/config/file-lock";
import { DeviceFlowError, type TokenResponse } from "../../../src/auth/oauth-device";
import type { TokenStore } from "../../../src/config/token-store";

function memStore(initial: Record<string, string> = {}): TokenStore {
  const m = new Map(Object.entries(initial));
  return {
    kind: "memory",
    get: (k: string) => Promise.resolve(m.get(k) ?? null),
    set: (k: string, v: string) => {
      m.set(k, v);
      return Promise.resolve();
    },
    delete: (k: string) => {
      m.delete(k);
      return Promise.resolve();
    },
  };
}

const tokens = (over: Partial<TokenResponse> = {}): TokenResponse => ({
  access_token: "at2",
  refresh_token: "rt2",
  scope: "openid",
  expires_in: 3600,
  ...over,
});

const baseDeps = (over: Partial<Parameters<typeof refreshSession>[0]> = {}) => ({
  store: memStore({ staging: "oldtok", "staging-refresh": "rt1" }),
  profileName: "staging",
  refreshTokenRef: "reoclo-staging-refresh",
  failedToken: "oldtok",
  authUrl: "https://auth.x",
  clientId: "cli",
  refreshFn: () => Promise.resolve(tokens()),
  withLock: <T>(fn: () => Promise<T>) => fn(),
  sleep: () => Promise.resolve(), // no real backoff delay in tests
  ...over,
});

describe("refreshSession", () => {
  test("double-check: returns an already-refreshed token without calling refreshFn", async () => {
    let called = false;
    const out = await refreshSession(
      baseDeps({
        store: memStore({ staging: "newtok" }),
        failedToken: "oldtok",
        refreshFn: () => {
          called = true;
          return Promise.resolve(tokens());
        },
      }),
    );
    expect(out).toBe("newtok");
    expect(called).toBe(false);
  });

  test("missing refresh token → ReauthRequiredError(missing)", async () => {
    const err = await refreshSession(
      baseDeps({ store: memStore({ staging: "oldtok" }), refreshTokenRef: undefined }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReauthRequiredError);
    expect((err as Error).message).toMatch(/no stored session/i);
  });

  test("server rejects refresh (4xx) → ReauthRequiredError(rejected)", async () => {
    const err = await refreshSession(
      baseDeps({
        refreshFn: () => Promise.reject(new DeviceFlowError("network", "invalid_grant", 400)),
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReauthRequiredError);
    expect((err as Error).message).toMatch(/rejected|expired|revoked/i);
  });

  test("transient network error (no status) → returns null", async () => {
    const out = await refreshSession(
      baseDeps({
        refreshFn: () => Promise.reject(new DeviceFlowError("network", "ECONNREFUSED")),
      }),
    );
    expect(out).toBeNull();
  });

  test("rate-limit / transient 4xx (429) → null, NOT ReauthRequiredError", async () => {
    const out = await refreshSession(
      baseDeps({
        refreshFn: () => Promise.reject(new DeviceFlowError("network", "Too Many Requests", 429)),
      }),
    );
    expect(out).toBeNull();
  });

  test("5xx → null (transient)", async () => {
    const out = await refreshSession(
      baseDeps({
        refreshFn: () => Promise.reject(new DeviceFlowError("network", "bad gateway", 502)),
      }),
    );
    expect(out).toBeNull();
  });

  test("lock timeout with a peer refresh already landed → returns the peer's token, no refresh", async () => {
    let called = false;
    const out = await refreshSession(
      baseDeps({
        store: memStore({ staging: "newtok", "staging-refresh": "rt1" }),
        failedToken: "oldtok",
        withLock: () => Promise.reject(new LockTimeoutError("timeout")),
        refreshFn: () => {
          called = true;
          return Promise.resolve(tokens());
        },
      }),
    );
    expect(out).toBe("newtok");
    expect(called).toBe(false);
  });

  test("lock timeout with no peer refresh → null (surface original 401, don't double-spend)", async () => {
    let called = false;
    const out = await refreshSession(
      baseDeps({
        store: memStore({ staging: "oldtok", "staging-refresh": "rt1" }),
        failedToken: "oldtok",
        withLock: () => Promise.reject(new LockTimeoutError("timeout")),
        refreshFn: () => {
          called = true;
          return Promise.resolve(tokens());
        },
      }),
    );
    expect(out).toBeNull();
    expect(called).toBe(false);
  });

  test("success → persists new access+refresh, returns new access, reports expiry", async () => {
    const store = memStore({ staging: "oldtok", "staging-refresh": "rt1" });
    let expiry: string | undefined = "unset";
    const out = await refreshSession(
      baseDeps({ store, onExpiry: (e) => { expiry = e; } }),
    );
    expect(out).toBe("at2");
    expect(await store.get("staging")).toBe("at2");
    expect(await store.get("staging-refresh")).toBe("rt2");
    expect(typeof expiry).toBe("string");
  });

  test("passes the located refresh token + authUrl + clientId to refreshFn", async () => {
    let seen: string[] = [];
    await refreshSession(
      baseDeps({
        refreshFn: (a: string, r: string, c: string) => {
          seen = [a, r, c];
          return Promise.resolve(tokens());
        },
      }),
    );
    expect(seen).toEqual(["https://auth.x", "rt1", "cli"]);
  });

  test("falls back to the legacy ref key and persists rotated token back there", async () => {
    const store = memStore({ staging: "oldtok", "reoclo-staging-refresh": "rtLegacy" });
    const out = await refreshSession(baseDeps({ store }));
    expect(out).toBe("at2");
    expect(await store.get("reoclo-staging-refresh")).toBe("rt2");
    expect(await store.get("staging-refresh")).toBeNull();
  });

  // ---- transient-failure retry (root cause of the daily re-login bug) ----

  test("retries a transient failure, then succeeds (no forced re-login)", async () => {
    let calls = 0;
    let sleeps = 0;
    const out = await refreshSession(
      baseDeps({
        sleep: () => { sleeps++; return Promise.resolve(); },
        refreshFn: () => {
          calls++;
          if (calls === 1) return Promise.reject(new DeviceFlowError("network", "ECONNRESET"));
          return Promise.resolve(tokens());
        },
      }),
    );
    expect(out).toBe("at2"); // recovered instead of surfacing the 401
    expect(calls).toBe(2);
    expect(sleeps).toBe(1); // backed off once between attempts
  });

  test("retries a 429 rate-limit before giving up", async () => {
    let calls = 0;
    const out = await refreshSession(
      baseDeps({
        refreshFn: () => { calls++; return Promise.reject(new DeviceFlowError("network", "Too Many Requests", 429)); },
      }),
    );
    expect(out).toBeNull();
    expect(calls).toBe(3); // default maxAttempts, not a single shot
  });

  test("retries a 5xx before giving up", async () => {
    let calls = 0;
    const out = await refreshSession(
      baseDeps({
        refreshFn: () => { calls++; return Promise.reject(new DeviceFlowError("network", "bad gateway", 502)); },
      }),
    );
    expect(out).toBeNull();
    expect(calls).toBe(3);
  });

  test("does NOT retry a definitive 4xx (400) — re-login required immediately", async () => {
    let calls = 0;
    const err = await refreshSession(
      baseDeps({
        refreshFn: () => { calls++; return Promise.reject(new DeviceFlowError("network", "invalid_grant", 400)); },
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReauthRequiredError);
    expect(calls).toBe(1); // no wasted retries on a hard rejection
  });

  test("honors an explicit maxAttempts", async () => {
    let calls = 0;
    const out = await refreshSession(
      baseDeps({
        maxAttempts: 5,
        refreshFn: () => { calls++; return Promise.reject(new DeviceFlowError("network", "ECONNREFUSED")); },
      }),
    );
    expect(out).toBeNull();
    expect(calls).toBe(5);
  });
});

describe("singleFlightRefresh", () => {
  test("dedupes concurrent calls for the same profile", async () => {
    let count = 0;
    const fn = async (): Promise<string | null> => {
      count++;
      await new Promise((r) => setTimeout(r, 10));
      return "x";
    };
    const [a, b] = await Promise.all([
      singleFlightRefresh("p", fn),
      singleFlightRefresh("p", fn),
    ]);
    expect(a).toBe("x");
    expect(b).toBe("x");
    expect(count).toBe(1);
  });

  test("different profiles do not dedupe", async () => {
    let count = 0;
    const fn = async (): Promise<string | null> => {
      count++;
      await new Promise((r) => setTimeout(r, 5));
      return "x";
    };
    await Promise.all([singleFlightRefresh("a", fn), singleFlightRefresh("b", fn)]);
    expect(count).toBe(2);
  });

  test("clears after completion so a later call re-runs", async () => {
    let count = 0;
    const fn = (): Promise<string | null> => {
      count++;
      return Promise.resolve("x");
    };
    await singleFlightRefresh("p", fn);
    await singleFlightRefresh("p", fn);
    expect(count).toBe(2);
  });
});
