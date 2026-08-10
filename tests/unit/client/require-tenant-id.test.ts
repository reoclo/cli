import { expect, test } from "bun:test";
import { requireTenantId } from "../../../src/client/bootstrap";

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
