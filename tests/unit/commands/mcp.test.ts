// tests/unit/commands/mcp.test.ts
//
// resolveMcpBootstrap() is mcp.ts's own tenant-resolution wiring: bootstrap()
// + requireTenantId(), extracted so it can be driven directly without also
// spinning up the stdio transport / background refresh loop the full `mcp`
// action performs.
//
// Regression coverage for the finding: every MCP tool module reads
// `ctx.tenantId` raw (no requireTenantId indirection) and no-ops when it's
// undefined. `ctx.tenantId` alone is undefined for an env credential
// (REOCLO_MACHINE_TOKEN / REOCLO_AUTOMATION_KEY — see bootstrap.ts). So if
// mcp.ts ever passes the raw `ctx.tenantId` into createMcpServer instead of
// resolving it lazily through requireTenantId, an env credential registers
// only the one tenant-optional tool (whoami) out of 79 — silently, no error,
// no stderr. This asserts the tenant handed to createMcpServer is the
// credential's OWN tenant (from /auth/me), never undefined and never an
// ambient profile's.
//
// Follows the Bun.serve seam from tests/unit/client/http.test.ts and
// tests/unit/client/secrets.test.ts for stubbing /auth/me.

import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveMcpBootstrap } from "../../../src/commands/mcp";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mcp-boot-"));
  process.env.REOCLO_CONFIG_DIR = tmp;
  delete process.env.REOCLO_API_KEY;
  delete process.env.REOCLO_AUTOMATION_KEY;
  delete process.env.REOCLO_MACHINE_TOKEN;
  delete process.env.REOCLO_PROFILE;
  delete process.env.REOCLO_ORG;
  delete process.env.REOCLO_API_URL;
  delete process.env.REOCLO_STREAMS_URL;
});
afterEach(() => {
  delete process.env.REOCLO_CONFIG_DIR;
  delete process.env.REOCLO_MACHINE_TOKEN;
  delete process.env.REOCLO_API_URL;
  delete process.env.REOCLO_STREAMS_URL;
});

function seedConfig(dir: string, cfg: object): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
}

function profileRecord(token: string, slug: string) {
  return {
    api_url: "https://api.reoclo.com",
    token,
    token_type: "tenant",
    tenant_id: `t-${slug}`,
    tenant_slug: slug,
    user_email: "dev@example.com",
    saved_at: "2026-01-01T00:00:00Z",
  };
}

test("resolveMcpBootstrap resolves the machine token's own tenant, not an ambient profile's", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/mcp/auth/me") {
        return Response.json({
          id: "u-1",
          email: "m@x",
          tenant_id: "t-token-own",
          tenant_slug: "token-org",
          roles: [],
        });
      }
      return Response.json({ items: [] });
    },
  });
  // The ambient profile belongs to a DIFFERENT org than the machine token.
  seedConfig(tmp, {
    active_profile: "default",
    profiles: { default: profileRecord("tok-default", "profile-org") },
  });
  process.env.REOCLO_MACHINE_TOKEN = "rk_m_" + "a".repeat(48);
  process.env.REOCLO_API_URL = `http://localhost:${server.port}`;
  let tenantId: string | undefined;
  try {
    ({ tenantId } = await resolveMcpBootstrap());
  } finally {
    await server.stop();
  }
  expect(tenantId).toBeDefined();
  expect(tenantId).toBe("t-token-own");
  expect(tenantId).not.toBe("t-profile-org");
});

test("resolveMcpBootstrap throws exit 3 when the credential's own /auth/me carries no tenant (honest failure, not a near-empty tool list)", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/mcp/auth/me") {
        // No tenant_id in the response: the genuinely tenantless case.
        return Response.json({ id: "u-1", email: "m@x", roles: [] });
      }
      return Response.json({ items: [] });
    },
  });
  process.env.REOCLO_MACHINE_TOKEN = "rk_m_" + "b".repeat(48);
  process.env.REOCLO_API_URL = `http://localhost:${server.port}`;
  let caught: unknown;
  try {
    await resolveMcpBootstrap();
  } catch (e) {
    caught = e;
  } finally {
    await server.stop();
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as { exitCode?: number }).exitCode).toBe(3);
});
