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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildSignedOutMcpContext,
  resolveMcpBootstrap,
  resolveMcpStart,
  signedOutMcpError,
} from "../../../src/commands/mcp";
import { createMcpServer } from "../../../src/mcp/server";
import { rejectionOf } from "../../helpers/rejection";

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

test("resolveMcpBootstrap serves an OAuth profile with no org bound instead of exiting", async () => {
  seedConfig(tmp, {
    active_profile: "default",
    profiles: { default: { ...profileRecord("tok-oauth", "login-org"), auth_kind: "oauth", token_type: "oauth" } },
  });
  const { ctx, tenantId } = await resolveMcpBootstrap();
  expect(tenantId).toBeUndefined();
  expect(ctx.orgSlug).toBeUndefined();
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

test("resolveMcpStart answers a missing sign-in with the error to serve, not a throw", async () => {
  const start = await resolveMcpStart();
  expect("signedOut" in start).toBe(true);
  if ("signedOut" in start) {
    expect((start.signedOut as Error & { exitCode?: number }).exitCode).toBe(3);
    expect(start.signedOut.message).toContain("reoclo login");
  }
});

test("resolveMcpStart still throws for a credential that is malformed (exit 2)", async () => {
  process.env.REOCLO_MACHINE_TOKEN = "not-a-machine-token";
  const err = await rejectionOf(resolveMcpStart());
  expect((err as { exitCode?: number }).exitCode).toBe(2);
});

test("resolveMcpStart serves a signed-in profile as before", async () => {
  seedConfig(tmp, {
    active_profile: "default",
    profiles: { default: { ...profileRecord("tok-oauth", "login-org"), auth_kind: "oauth", token_type: "oauth" } },
  });
  const start = await resolveMcpStart();
  expect("ctx" in start).toBe(true);
});

test("a signed-out server lists every tool, fails each with the login instruction and keeps the guides", async () => {
  const server = createMcpServer(buildSignedOutMcpContext(signedOutMcpError(new Error("not authenticated: run 'reoclo login'"))));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent-x", version: "1" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  expect(names).toContain("list_servers");
  expect(names).toContain("whoami");
  expect(names).toContain("get_test_pool");

  const refused: Array<[string, Record<string, unknown>]> = [
    ["whoami", {}],
    ["list_servers", {}],
    ["list_test_pools", {}],
    ["get_test_pool", { pool: "ci" }],
  ];
  for (const [name, args] of refused) {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>).map((c) => c.text).join("");
    expect({ name, isError: res.isError }).toEqual({ name, isError: true });
    expect(text.split("reoclo login")).toHaveLength(2); // named once, not repeated by the wrapper
  }

  const guides = await client.callTool({ name: "list_guides", arguments: {} });
  expect(guides.isError).not.toBe(true);
  await client.close();
});
