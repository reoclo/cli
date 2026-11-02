// tests/unit/client/bootstrap-org-refresh.test.ts
//
// An `--org` override mints an in-memory tenant_switch token that carries no
// refresh token. These tests prove it is renewed by minting again from a live
// profile token, instead of failing with 401 once its hour runs out. The
// profile is a config-file one and the keyring is stubbed out, so nothing here
// reaches the developer's real OS keyring; the API and auth server are a local
// fake.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootstrap } from "../../../src/client/bootstrap";
import { withKeyringStore } from "../../../src/config/token-store";

let tmp: string;
let server: ReturnType<typeof Bun.serve>;
let mintedFrom: string[];
let refreshCalls: string[];
let orgTokens: string[];
let rejectMintFrom: string | undefined;

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: object): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(claims)}.sig`;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "boot-org-"));
  process.env.REOCLO_CONFIG_DIR = tmp;
  process.env.REOCLO_CACHE_DIR = join(tmp, "cache");
  delete process.env.CI;
  delete process.env.REOCLO_ORG;
  mintedFrom = [];
  refreshCalls = [];
  orgTokens = [];
  rejectMintFrom = undefined;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/auth/me")) {
        return Response.json({
          email: "dev@example.com",
          tenant_id: "t-home",
          tenant_slug: "home",
          memberships: [
            { tenant_id: "t-home", tenant_slug: "home" },
            { tenant_id: "t-other", tenant_slug: "other" },
          ],
        });
      }
      if (path === "/oauth/token") {
        const form = new URLSearchParams(await req.text());
        if (form.get("grant_type") === "tenant_switch") {
          const from = form.get("current_access_token") ?? "";
          mintedFrom.push(from);
          if (from === rejectMintFrom) {
            return Response.json(
              { detail: { error: "invalid_grant", error_description: "Invalid current_access_token" } },
              { status: 400 },
            );
          }
          const token = jwt({
            exp: Math.floor(Date.now() / 1000) + 3600,
            tid: form.get("tenant_id"),
            n: orgTokens.length + 1,
          });
          orgTokens.push(token);
          return Response.json({ access_token: token, refresh_token: "", expires_in: 3600 });
        }
        if (form.get("grant_type") === "refresh_token") {
          refreshCalls.push(form.get("refresh_token") ?? "");
          const n = refreshCalls.length;
          return Response.json({
            access_token: `access-${n}`,
            refresh_token: `rt-next-${n}`,
            scope: "",
            expires_in: 3600,
          });
        }
      }
      if (path.endsWith("/ping")) {
        // Only the second org token is accepted: the first one has "expired".
        const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
        if (bearer === orgTokens[1]) return Response.json({ ok: true });
        return Response.json({ detail: "token expired" }, { status: 401 });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterEach(() => {
  void server.stop();
  delete process.env.REOCLO_CONFIG_DIR;
  delete process.env.REOCLO_CACHE_DIR;
});

function seedFileProfile(overrides: Record<string, unknown> = {}): void {
  const base = `http://localhost:${server.port}`;
  const profile = {
    api_url: base,
    streams_url: base,
    token: "profile-1",
    refresh_token: "rt-1",
    token_type: "automation",
    tenant_id: "t-home",
    tenant_slug: "home",
    user_email: "dev@example.com",
    saved_at: "2026-01-01T00:00:00Z",
    auth_kind: "oauth",
    oauth_client_id: "reoclo-cli",
    oauth_auth_url: base,
    access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
  writeFileSync(
    join(tmp, "config.json"),
    JSON.stringify({ active_profile: "default", profiles: { default: profile } }),
  );
}

function setStoredExpiry(expiresAt: string): void {
  const path = join(tmp, "config.json");
  const cfg = JSON.parse(readFileSync(path, "utf8")) as {
    profiles: { default: Record<string, unknown> };
  };
  cfg.profiles.default.access_token_expires_at = expiresAt;
  writeFileSync(path, JSON.stringify(cfg));
}

const noKeyring = <T>(fn: () => T): T => withKeyringStore(null, fn);

test("an --org token is renewable, and renewing mints for the same org from the profile token", async () => {
  seedFileProfile();

  const ctx = await noKeyring(() => bootstrap({ org: "other" }));

  expect(ctx.token).toBe(orgTokens[0] as string);
  expect(ctx.orgSwitched).toBe(true);
  expect(ctx.tenantId).toBe("t-other");
  expect(Date.parse(ctx.accessTokenExpiresAt ?? "")).toBeGreaterThan(Date.now());
  expect(typeof ctx.refresh).toBe("function");

  const renewed = await noKeyring(() => ctx.refresh?.(ctx.token));

  expect(renewed).toBe(orgTokens[1] as string);
  expect(mintedFrom).toEqual(["profile-1", "profile-1"]);
  expect(refreshCalls).toEqual([]);
});

test("a 401 under --org re-mints the org token and retries the request", async () => {
  seedFileProfile();
  const ctx = await noKeyring(() => bootstrap({ org: "other" }));

  const res = await noKeyring(() => ctx.client.get<{ ok: boolean }>("/tenants/t-other/ping"));

  expect(res.ok).toBe(true);
  expect(mintedFrom).toHaveLength(2);
});

test("renewing refreshes a profile token that is due first, then mints from the fresh one", async () => {
  seedFileProfile();
  const ctx = await noKeyring(() => bootstrap({ org: "other" }));
  setStoredExpiry("2020-01-01T00:00:00Z");

  const renewed = await noKeyring(() => ctx.refresh?.(ctx.token));

  expect(renewed).toBe(orgTokens[1] as string);
  expect(refreshCalls).toEqual(["rt-1"]);
  expect(mintedFrom).toEqual(["profile-1", "access-1"]);
});

test("a mint that rejects the profile token refreshes it once and mints again", async () => {
  seedFileProfile();
  const ctx = await noKeyring(() => bootstrap({ org: "other" }));
  rejectMintFrom = "profile-1";

  const renewed = await noKeyring(() => ctx.refresh?.(ctx.token));

  expect(renewed).toBe(orgTokens[1] as string);
  expect(refreshCalls).toEqual(["rt-1"]);
  expect(mintedFrom).toEqual(["profile-1", "profile-1", "access-1"]);
});
