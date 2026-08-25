import { expect, test } from "bun:test";
import { buildCliMcpContext } from "../../../src/commands/mcp";
import { registerAllTools } from "../../../src/mcp/tools";
import type { HttpClient } from "../../../src/client/http";

const client = {} as HttpClient;

test("CLI context exposes no organization argument", () => {
  const ctx = buildCliMcpContext(client, "t-bound");
  expect(ctx.orgParam).toEqual({});
  const schemas: Record<string, object> = {};
  const server = { tool(name: string, ...rest: unknown[]) { schemas[name] = (rest.find((r) => r && typeof r === "object" && typeof r !== "function") ?? {}) as object; } };
  registerAllTools(server as never, ctx);
  for (const [name, schema] of Object.entries(schemas)) {
    expect(Object.keys(schema), `${name} must not expose organization on the CLI`).not.toContain("organization");
  }
});

test("CLI context resolves to the bootstrap-bound tenant and ignores any argument", async () => {
  const ctx = buildCliMcpContext(client, "t-bound");
  expect(await ctx.resolveOrg()).toEqual({ tenantId: "t-bound", client });
  expect(await ctx.resolveOrg("someone-else")).toEqual({ tenantId: "t-bound", client });
});
