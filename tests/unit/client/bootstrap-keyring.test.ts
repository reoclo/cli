// tests/unit/client/bootstrap-keyring.test.ts
//
// bootstrap() reading a keyring-backed OAuth profile. The keyring is an
// in-memory stand-in (withKeyringStore) and the auth server a local fake, so
// nothing here reaches the developer's real OS keyring or Reoclo.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootstrap } from "../../../src/client/bootstrap";
import { ReauthRequiredError } from "../../../src/client/errors";
import { withKeyringStore } from "../../../src/config/token-store";
import { MemoryStore } from "../../../src/config/keyring/memory";

let tmp: string;
let auth: ReturnType<typeof Bun.serve>;
let refreshCalls: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "boot-keyring-"));
  process.env.REOCLO_CONFIG_DIR = tmp;
  process.env.REOCLO_CACHE_DIR = join(tmp, "cache");
  delete process.env.CI;
  refreshCalls = [];
  auth = Bun.serve({
    port: 0,
    async fetch(req) {
      const form = new URLSearchParams(await req.text());
      if (new URL(req.url).pathname !== "/oauth/token" || form.get("grant_type") !== "refresh_token") {
        return new Response("not found", { status: 404 });
      }
      const presented = form.get("refresh_token") ?? "";
      refreshCalls.push(presented);
      const n = refreshCalls.length;
      return Response.json({
        access_token: `access-${n}`,
        refresh_token: `rt-next-${n}`,
        scope: "",
        expires_in: 3600,
      });
    },
  });
});

afterEach(() => {
  void auth.stop();
  delete process.env.REOCLO_CONFIG_DIR;
  delete process.env.REOCLO_CACHE_DIR;
  delete process.env.CI;
});

function seedKeyringProfile(overrides: Record<string, unknown> = {}): void {
  const profile = {
    api_url: "https://api.reoclo.com",
    token_type: "automation",
    tenant_id: "t-home",
    tenant_slug: "home",
    user_email: "dev@example.com",
    saved_at: "2026-01-01T00:00:00Z",
    auth_kind: "oauth",
    oauth_client_id: "reoclo-cli",
    oauth_auth_url: `http://localhost:${auth.port}`,
    token_ref: "keyring:reoclo-default",
    refresh_token_ref: "default-refresh",
    access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
  writeFileSync(
    join(tmp, "config.json"),
    JSON.stringify({ active_profile: "default", profiles: { default: profile } }),
  );
}

const PAST = "2020-01-01T00:00:00Z";

test("a missing access token is recovered with the refresh token, once, and persisted", async () => {
  // The expiry is past as well: the recovery must not be followed by a second,
  // proactive refresh that spends the freshly rotated token again.
  seedKeyringProfile({ access_token_expires_at: PAST });
  const keyring = new MemoryStore();
  await keyring.set("default-refresh", "rt-1");

  const ctx = await withKeyringStore(keyring, () => bootstrap({ org: "home" }));

  expect(ctx.token).toBe("access-1");
  expect(refreshCalls).toEqual(["rt-1"]);
  expect(await keyring.get("default")).toBe("access-1");
  expect(await keyring.get("default-refresh")).toBe("rt-next-1");
  const saved = JSON.parse(readFileSync(join(tmp, "config.json"), "utf8")) as {
    profiles: { default: { access_token_expires_at: string } };
  };
  expect(Date.parse(saved.profiles.default.access_token_expires_at)).toBeGreaterThan(Date.now());
});

test("the network-free preAction probe recovers a missing access token the same way", async () => {
  seedKeyringProfile();
  const keyring = new MemoryStore();
  await keyring.set("default-refresh", "rt-1");

  const ctx = await withKeyringStore(keyring, () =>
    bootstrap({ orgRequired: false, networkFree: true }),
  );

  expect(ctx.token).toBe("access-1");
  expect(refreshCalls).toEqual(["rt-1"]);
});

test("with neither token stored, bootstrap asks to sign in to that profile", async () => {
  seedKeyringProfile();
  const keyring = new MemoryStore();

  let caught: unknown;
  try {
    await withKeyringStore(keyring, () => bootstrap({ org: "home" }));
  } catch (e) {
    caught = e;
  }

  expect(caught).toBeInstanceOf(ReauthRequiredError);
  expect((caught as Error).message).toContain("no stored session to refresh for profile 'default'");
  expect(refreshCalls).toEqual([]);
});

test("CI=1 reads and refreshes a keyring profile from the keyring, not config.json", async () => {
  process.env.CI = "1";
  seedKeyringProfile({ access_token_expires_at: PAST });
  const keyring = new MemoryStore();
  await keyring.set("default", "access-old");
  await keyring.set("default-refresh", "rt-1");

  const ctx = await withKeyringStore(keyring, () => bootstrap({ org: "home" }));

  expect(ctx.token).toBe("access-1");
  expect(refreshCalls).toEqual(["rt-1"]);
  expect(await keyring.get("default-refresh")).toBe("rt-next-1");
});

test("a config-file login refreshes with its inline refresh token and rotates it in place", async () => {
  seedKeyringProfile({
    token_ref: undefined,
    refresh_token_ref: undefined,
    token: "access-old",
    refresh_token: "rt-1",
    access_token_expires_at: PAST,
  });
  const keyring = new MemoryStore();

  const ctx = await withKeyringStore(keyring, () => bootstrap({ org: "home" }));

  expect(ctx.token).toBe("access-1");
  expect(refreshCalls).toEqual(["rt-1"]);
  const saved = JSON.parse(readFileSync(join(tmp, "config.json"), "utf8")) as {
    profiles: { default: Record<string, unknown> };
  };
  expect(saved.profiles.default.token).toBe("access-1");
  expect(saved.profiles.default.refresh_token).toBe("rt-next-1");
  expect(saved.profiles.default.refresh_token_ref).toBeUndefined();
  expect(await keyring.get("default")).toBeNull();
  expect(await keyring.get("default-refresh")).toBeNull();
});

test("CI=1 uses a keyring profile's stored access token as-is when it is still fresh", async () => {
  process.env.CI = "1";
  seedKeyringProfile();
  const keyring = new MemoryStore();
  await keyring.set("default", "access-stored");
  await keyring.set("default-refresh", "rt-1");

  const ctx = await withKeyringStore(keyring, () => bootstrap({ org: "home" }));

  expect(ctx.token).toBe("access-stored");
  expect(refreshCalls).toEqual([]);
});
