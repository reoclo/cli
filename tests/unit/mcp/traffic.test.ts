// The traffic tools are read-only proxies. Driven against the registration
// function with a recording fake server, like domains.test.ts.
import { expect, test } from "bun:test";
import { z } from "zod";
import { registerTrafficTools } from "../../../src/mcp/tools/traffic";
import { registerAllTools } from "../../../src/mcp/tools";
import type { McpRegistrationContext, OrgScope } from "../../../src/mcp/tools/context";

type Registered = {
  name: string;
  schema: Record<string, z.ZodType>;
  cb: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;
};

function harness(register: (server: never, ctx: McpRegistrationContext) => void): {
  registry: Registered[];
  gets: string[];
} {
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
  const gets: string[] = [];
  const client = {
    get: (path: string) => {
      gets.push(path);
      return Promise.resolve({ ok: true });
    },
  } as unknown as McpRegistrationContext["client"];
  const ctx: McpRegistrationContext = {
    client,
    orgParam: { organization: z.string().min(1) },
    resolveOrg: (): Promise<OrgScope> => Promise.resolve({ tenantId: "T-ACME", client }),
  };
  register(server as never, ctx);
  return { registry, gets };
}

function tool(registry: Registered[], name: string): Registered {
  const found = registry.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

test("registerAllTools registers both traffic tools", () => {
  const { registry } = harness(registerAllTools);
  const names = registry.map((t) => t.name);
  expect(names).toContain("get_traffic_summary");
  expect(names).toContain("list_traffic_routes");
});

test("get_traffic_summary proxies the summary route with the route filter", async () => {
  const { registry, gets } = harness(registerTrafficTools);
  const result = await tool(registry, "get_traffic_summary").cb({
    organization: "acme",
    application_id: "APP1",
    range: "24h",
    route: "/users/:id",
    method: "get",
  });
  expect(result.isError).toBeUndefined();
  const [path = "", search = ""] = (gets[0] ?? "").split("?");
  expect(path).toBe("/tenants/T-ACME/traffic/summary");
  const params = new URLSearchParams(search);
  expect(params.get("application_id")).toBe("APP1");
  expect(params.get("range")).toBe("24h");
  expect(params.get("route")).toBe("/users/:id");
  expect(params.get("method")).toBe("GET");
});

test("list_traffic_routes proxies the routes route with sort and limit", async () => {
  const { registry, gets } = harness(registerTrafficTools);
  await tool(registry, "list_traffic_routes").cb({
    organization: "acme",
    domain_id: "DOM1",
    sort: "errors",
    limit: 5,
  });
  const [path = "", search = ""] = (gets[0] ?? "").split("?");
  expect(path).toBe("/tenants/T-ACME/traffic/routes");
  const params = new URLSearchParams(search);
  expect(params.get("domain_id")).toBe("DOM1");
  expect(params.get("sort")).toBe("errors");
  expect(params.get("limit")).toBe("5");
  expect(params.has("application_id")).toBe(false);
});

test("the traffic tools refuse zero or two subjects without calling the API", async () => {
  const { registry, gets } = harness(registerTrafficTools);
  for (const name of ["get_traffic_summary", "list_traffic_routes"]) {
    const none = await tool(registry, name).cb({ organization: "acme" });
    expect(none.isError).toBe(true);
    expect(none.content[0]?.text).toContain("exactly one of application_id or domain_id");
    const both = await tool(registry, name).cb({
      organization: "acme",
      application_id: "APP1",
      domain_id: "DOM1",
    });
    expect(both.isError).toBe(true);
  }
  expect(gets).toEqual([]);
});

test("get_traffic_summary refuses a route without a method", async () => {
  const { registry, gets } = harness(registerTrafficTools);
  const result = await tool(registry, "get_traffic_summary").cb({
    organization: "acme",
    application_id: "APP1",
    route: "/users/:id",
  });
  expect(result.isError).toBe(true);
  expect(gets).toEqual([]);
});
