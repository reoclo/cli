import { expect, test } from "bun:test";
import { requireTenantId } from "../../../src/client/bootstrap";
import { getSlice, setActiveOrg, writeSlice } from "../../../src/completion/cache";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("returns the context tenant without a network call", async () => {
  const ctx = { tenantId: "t-1", client: { get: () => { throw new Error("network"); } } };
  expect(await requireTenantId(ctx as never)).toBe("t-1");
});

test("resolves via /auth/me once and memoizes on the context", async () => {
  let calls = 0;
  const ctx = { tenantId: undefined, client: { get: async (p: string) => { calls++; expect(p).toBe("/auth/me"); return { tenant_id: "t-9" }; } } };
  expect(await requireTenantId(ctx as never)).toBe("t-9");
  expect(await requireTenantId(ctx as never)).toBe("t-9");
  expect(calls).toBe(1);
});

test("exits 3 when /auth/me has no tenant", async () => {
  const ctx = { tenantId: undefined, client: { get: async () => ({}) } };
  try {
    await requireTenantId(ctx as never);
    throw new Error("did not throw");
  } catch (e) {
    expect((e as { exitCode?: number }).exitCode).toBe(3);
  }
});

// Explicit-org policy: an OAuth profile has no implicit org. When no override
// selected one (ctx.tenantId unset), the login org must NOT be resolved from
// /auth/me on the sly — that is exactly the "falls back to the first
// membership" leak. The command fails the same way the bootstrap gate does.
test("an OAuth profile with no override exits 4 and makes no network call", async () => {
  let calls = 0;
  const ctx = {
    tenantId: undefined,
    authKind: "oauth",
    client: { get: () => { calls++; return Promise.resolve({ tenant_id: "t-login" }); } },
  };
  try {
    await requireTenantId(ctx as never);
    throw new Error("did not throw");
  } catch (e) {
    expect((e as { exitCode?: number }).exitCode).toBe(4);
    expect(String((e as Error).message)).toContain("--org");
  }
  expect(calls).toBe(0);
});

// An env credential (automation key / machine token) is bound to one org and
// still resolves it from /auth/me; the completion cache is then stamped under
// that org's slug so cache writes land in the right bucket.
test("an env credential resolves /auth/me and stamps the cache under its own org slug", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "rti-cache-"));
  process.env.REOCLO_CACHE_DIR = cacheDir;
  try {
    setActiveOrg(undefined, undefined);
    const ctx = {
      tenantId: undefined,
      authKind: undefined,
      profileName: "default",
      client: { get: () => Promise.resolve({ tenant_id: "t-robot", tenant_slug: "robot-org" }) },
    };
    expect(await requireTenantId(ctx as never)).toBe("t-robot");
    const entry = { id: "s1", value: "s1", name: "s1", desc: "" };
    writeSlice("servers", [entry]);
    setActiveOrg("default", "robot-org");
    expect(getSlice("servers")).toEqual([entry]);
  } finally {
    setActiveOrg(undefined, undefined);
    delete process.env.REOCLO_CACHE_DIR;
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
