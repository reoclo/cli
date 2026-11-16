import { expect, test } from "bun:test";
import { buildCliMcpContext, buildUnboundMcpContext } from "../../../src/commands/mcp";
import { registerAllTools } from "../../../src/mcp/tools";
import type { HttpClient } from "../../../src/client/http";

const client = {} as HttpClient;

test("CLI context exposes no organization argument", () => {
  const ctx = buildCliMcpContext(client, "t-bound");
  expect(ctx.orgParam).toEqual({});
  const schemas: Record<string, object> = {};
  const server = { tool(name: string, ...rest: unknown[]) { schemas[name] = rest.find((r) => r && typeof r === "object" && typeof r !== "function") ?? {}; } };
  registerAllTools(server as never, ctx);
  for (const [name, schema] of Object.entries(schemas)) {
    expect(Object.keys(schema), `${name} must not expose organization on the CLI`).not.toContain("organization");
  }
});

test("an unbound CLI context makes every catalog tool take an organization", () => {
  const ctx = buildUnboundMcpContext(client, () => Promise.reject(new Error("unused")));
  const schemas: Record<string, object> = {};
  const server = { tool(name: string, ...rest: unknown[]) { schemas[name] = rest.find((r) => r && typeof r === "object" && typeof r !== "function") ?? {}; } };
  registerAllTools(server as never, ctx);
  expect(Object.keys(schemas).length).toBeGreaterThan(10);
  for (const [name, schema] of Object.entries(schemas)) {
    expect(Object.keys(schema), `${name} must take organization when no org is bound`).toContain("organization");
  }
});

test("an unbound CLI context resolves each organization once and retries one that failed", async () => {
  const asked: string[] = [];
  let failNext = true;
  const ctx = buildUnboundMcpContext(client, (org) => {
    asked.push(org);
    if (org === "flaky" && failNext) {
      failNext = false;
      return Promise.reject(new Error("org 'flaky' is not in your granted organizations"));
    }
    return Promise.resolve({ tenantId: `t-${org}`, client });
  });
  // The repo lint refuses `await expect(...).rejects`, which Bun types as non-thenable.
  const rejection = (p: Promise<unknown>): Promise<string> => p.then(() => "resolved", (e: unknown) => String(e));
  expect(await rejection(ctx.resolveOrg())).toContain("organization is required");
  expect(await rejection(ctx.resolveOrg("  "))).toContain("organization is required");
  expect(await ctx.resolveOrg("acme")).toEqual({ tenantId: "t-acme", client });
  expect(await ctx.resolveOrg(" acme ")).toEqual({ tenantId: "t-acme", client });
  expect(await rejection(ctx.resolveOrg("flaky"))).toContain("not in your granted organizations");
  expect(await ctx.resolveOrg("flaky")).toEqual({ tenantId: "t-flaky", client });
  expect(asked).toEqual(["acme", "flaky", "flaky"]);
});

test("CLI context resolves to the bootstrap-bound tenant and ignores any argument", async () => {
  const ctx = buildCliMcpContext(client, "t-bound");
  expect(await ctx.resolveOrg()).toEqual({ tenantId: "t-bound", client });
  expect(await ctx.resolveOrg("someone-else")).toEqual({ tenantId: "t-bound", client });
});
