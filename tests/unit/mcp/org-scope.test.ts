// Every tenant-scoped tool must (a) expose the host's org fragment and
// (b) resolve the organization through ctx.resolveOrg before its first HTTP
// call, then use the resolved tenant id in the path and the resolved client.
// Driven directly against the registration functions with a recording fake
// server, so it covers all tools without an MCP transport.
import { expect, test } from "bun:test";
import { z } from "zod";
import { registerAllTools } from "../../../src/mcp/tools";
import type { McpRegistrationContext, OrgScope } from "../../../src/mcp/tools/context";

type Registered = { name: string; schema: Record<string, z.ZodType>; cb: (args: Record<string, unknown>) => Promise<unknown> };

function fakeServer(): { registry: Registered[]; server: unknown } {
  const registry: Registered[] = [];
  const server = {
    tool(name: string, ...rest: unknown[]) {
      const cb = rest[rest.length - 1] as Registered["cb"];
      const schema = (rest.find((r) => r && typeof r === "object" && !Array.isArray(r) && typeof r !== "function" && !("readOnlyHint" in (r as object))) ?? {}) as Registered["schema"];
      registry.push({ name, schema, cb });
    },
  };
  return { registry, server };
}

function recordingClient(paths: string[]): McpRegistrationContext["client"] {
  const record = async (path: string) => {
    paths.push(path);
    return { items: [] };
  };
  return { get: record, post: record, put: record, patch: record, del: record } as unknown as McpRegistrationContext["client"];
}

test("every tenant-scoped tool spreads orgParam and resolves the org before calling the API", async () => {
  const { registry, server } = fakeServer();
  const ambientPaths: string[] = [];
  const resolvedPaths: string[] = [];
  const resolveCalls: unknown[] = [];
  const ctx: McpRegistrationContext = {
    client: recordingClient(ambientPaths),
    orgParam: { organization: z.string().min(1) },
    resolveOrg: async (organization?: unknown): Promise<OrgScope> => {
      resolveCalls.push(organization);
      return { tenantId: "T-ACME", client: recordingClient(resolvedPaths) };
    },
  };
  registerAllTools(server as never, ctx);
  expect(registry.length).toBeGreaterThanOrEqual(80);

  for (const tool of registry) {
    if (tool.name === "whoami") continue;
    expect(Object.keys(tool.schema), `${tool.name} must expose organization`).toContain("organization");

    resolveCalls.length = 0;
    ambientPaths.length = 0;
    resolvedPaths.length = 0;
    const args: Record<string, unknown> = { organization: "acme" };
    for (const key of Object.keys(tool.schema)) if (key !== "organization") args[key] = "x";
    await tool.cb(args);

    expect(resolveCalls, `${tool.name} must call resolveOrg`).toEqual(["acme"]);
    expect(ambientPaths, `${tool.name} must not use the ambient client`).toEqual([]);
    for (const p of resolvedPaths) {
      expect(p, `${tool.name} path must be tenant-scoped to the resolved org`).toMatch(/^\/tenants\/T-ACME\//);
    }
  }
});

test("whoami takes an optional organization and uses the ambient client without one", async () => {
  const { registry, server } = fakeServer();
  const ambientPaths: string[] = [];
  const resolvedPaths: string[] = [];
  const ctx: McpRegistrationContext = {
    client: recordingClient(ambientPaths),
    orgParam: { organization: z.string().min(1) },
    resolveOrg: async () => ({ tenantId: "T-ACME", client: recordingClient(resolvedPaths) }),
  };
  registerAllTools(server as never, ctx);
  const whoami = registry.find((t) => t.name === "whoami")!;
  expect(whoami.schema.organization!.safeParse(undefined).success).toBe(true);

  await whoami.cb({});
  expect(ambientPaths).toEqual(["/auth/me/acl"]);
  expect(resolvedPaths).toEqual([]);

  await whoami.cb({ organization: "acme" });
  expect(resolvedPaths).toEqual(["/auth/me/acl"]);
});
