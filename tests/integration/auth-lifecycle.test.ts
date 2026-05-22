// tests/integration/auth-lifecycle.test.ts
//
// End-to-end coverage of the OAuth device-flow login → whoami → logout
// lifecycle. Spins up two in-process fakes: an auth service that satisfies
// the OAuth 2.1 device-flow endpoints, and an API gateway that answers
// /mcp/auth/me. The CLI is driven with --no-browser to keep the run
// non-interactive in CI; the auth fake returns the access token immediately
// on the first poll.
import { expect, test, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmp: string;
let api: ReturnType<typeof Bun.serve>;
let auth: ReturnType<typeof Bun.serve>;
let apiUrl: string;
let authUrl: string;

const ACCESS_TOKEN = "oauth-access-token-fake";
const REFRESH_TOKEN = "oauth-refresh-token-fake";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reoclo-it-"));

  api = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const authz = req.headers.get("authorization");
      if (url.pathname === "/mcp/auth/me") {
        if (authz !== `Bearer ${ACCESS_TOKEN}`) return new Response("unauth", { status: 401 });
        return Response.json({
          id: "u1",
          email: "test@example.com",
          tenant_id: "t1",
          tenant_slug: "acme",
          roles: ["member"],
        });
      }
      if (url.pathname === "/mcp/auth/me/capabilities") {
        return Response.json({ grants: [] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  apiUrl = `http://localhost:${api.port}`;

  auth = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/oauth/device" && req.method === "POST") {
        return Response.json({
          device_code: "dev-code-1",
          user_code: "USER-CODE",
          verification_uri: `${authUrl}/device`,
          verification_uri_complete: `${authUrl}/device?user_code=USER-CODE`,
          expires_in: 600,
          interval: 0,
        });
      }
      if (url.pathname === "/oauth/token" && req.method === "POST") {
        // Immediately issue tokens — the device-flow fake skips the
        // pending-approval state used by the real server.
        return Response.json({
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  authUrl = `http://localhost:${auth.port}`;
});

afterEach(() => {
  void api.stop();
  void auth.stop();
});

test("login (device flow) → whoami → logout (file store, fake gateway + auth)", async () => {
  const env = { ...process.env, REOCLO_CONFIG_DIR: tmp };

  await $`bun run src/index.ts login --api ${apiUrl} --auth ${authUrl} --no-keyring --no-browser`.env(env);

  const who = await $`bun run src/index.ts whoami`.env(env).quiet();
  const out = who.stdout.toString();
  expect(out).toContain("organization:  acme");
  expect(out).toContain("user:          test@example.com");

  await $`bun run src/index.ts logout`.env(env);

  const after = await $`bun run src/index.ts whoami`.env(env).nothrow().quiet();
  expect(after.exitCode).toBe(3);
});
