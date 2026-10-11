import { expect, test } from "bun:test";
import { z } from "zod";
import { registerServerTools } from "../../../src/mcp/tools/servers";
import type { McpRegistrationContext, OrgScope } from "../../../src/mcp/tools/context";

type Registered = {
  name: string;
  schema: Record<string, z.ZodType>;
  cb: (args: Record<string, unknown>) => Promise<unknown>;
};

function harness(): { registry: Registered[]; puts: { path: string; body: unknown }[] } {
  const registry: Registered[] = [];
  const server = {
    tool(name: string, ...rest: unknown[]) {
      const cb = rest[rest.length - 1] as Registered["cb"];
      const schema = (rest.find(
        (r) => r && typeof r === "object" && !Array.isArray(r) && typeof r !== "function",
      ) ?? {}) as Registered["schema"];
      registry.push({ name, schema, cb });
    },
  };
  const puts: { path: string; body: unknown }[] = [];
  const client = {
    get: () => Promise.resolve({}),
    post: () => Promise.resolve({}),
    put: (path: string, body: unknown) => {
      puts.push({ path, body });
      return Promise.resolve({ mode: "managed" });
    },
    patch: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
  } as unknown as McpRegistrationContext["client"];
  const ctx: McpRegistrationContext = {
    client,
    orgParam: { organization: z.string().min(1) },
    resolveOrg: (): Promise<OrgScope> => Promise.resolve({ tenantId: "T-ACME", client }),
  };
  registerServerTools(server as never, ctx);
  return { registry, puts };
}

function setTool(registry: Registered[]): Registered {
  const found = registry.find((t) => t.name === "set_server_ip_allowlist");
  if (!found) throw new Error("set_server_ip_allowlist not registered");
  return found;
}

const ALLOWLIST = { cidrs: ["10.0.0.0/8"], presets: ["cloudflare"] };

test("set_server_ip_allowlist puts the allowlist, or null with clear", async () => {
  const { registry, puts } = harness();
  const tool = setTool(registry);
  await tool.cb({ organization: "acme", server_id: "S1", ip_allowlist: ALLOWLIST });
  await tool.cb({ organization: "acme", server_id: "S1", clear: true });
  expect(puts).toEqual([
    { path: "/tenants/T-ACME/servers/S1/proxy/ip-allowlist", body: { ip_allowlist: ALLOWLIST } },
    { path: "/tenants/T-ACME/servers/S1/proxy/ip-allowlist", body: { ip_allowlist: null } },
  ]);
});

test("set_server_ip_allowlist needs exactly one of ip_allowlist and clear", async () => {
  const { registry, puts } = harness();
  const tool = setTool(registry);
  const neither = (await tool.cb({ organization: "acme", server_id: "S1" })) as { isError?: boolean };
  const both = (await tool.cb({
    organization: "acme",
    server_id: "S1",
    ip_allowlist: ALLOWLIST,
    clear: true,
  })) as { isError?: boolean };
  expect(neither.isError).toBe(true);
  expect(both.isError).toBe(true);
  expect(puts).toEqual([]);
});

test("the allowlist schema caps cidrs at 100 and only accepts the cloudflare preset", () => {
  const schema = setTool(harness().registry).schema["ip_allowlist"]!;
  expect(schema.safeParse({ cidrs: Array.from({ length: 100 }, () => "10.0.0.0/8"), presets: [] }).success).toBe(true);
  expect(schema.safeParse({ cidrs: Array.from({ length: 101 }, () => "10.0.0.0/8"), presets: [] }).success).toBe(false);
  expect(schema.safeParse({ cidrs: [], presets: ["fastly"] }).success).toBe(false);
  expect(schema.safeParse({ presets: ["cloudflare"] }).success).toBe(true);
});
