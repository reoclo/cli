// add_domain must post the API's DomainCreate shape. It sent { domain_name }
// to a schema that requires `fqdn`, so every call was a 422 and the tool
// could never link a domain. Driven against the registration function with
// a recording fake server, like org-scope.test.ts.
import { expect, test } from "bun:test";
import { z } from "zod";
import { registerDomainTools } from "../../../src/mcp/tools/domains";
import type { McpRegistrationContext, OrgScope } from "../../../src/mcp/tools/context";

type Registered = {
  name: string;
  schema: Record<string, z.ZodType>;
  cb: (args: Record<string, unknown>) => Promise<unknown>;
};

function fakeServer(): { registry: Registered[]; server: unknown } {
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
  return { registry, server };
}

function harness(): {
  registry: Registered[];
  posts: { path: string; body: unknown }[];
} {
  const { registry, server } = fakeServer();
  const posts: { path: string; body: unknown }[] = [];
  const client = {
    get: () => Promise.resolve({}),
    post: (path: string, body: unknown) => {
      posts.push({ path, body });
      return Promise.resolve({ id: "D1", fqdn: "example.com" });
    },
    put: () => Promise.resolve({}),
    patch: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
  } as unknown as McpRegistrationContext["client"];
  const ctx: McpRegistrationContext = {
    client,
    orgParam: { organization: z.string().min(1) },
    resolveOrg: (): Promise<OrgScope> => Promise.resolve({ tenantId: "T-ACME", client }),
  };
  registerDomainTools(server as never, ctx);
  return { registry, posts };
}

function addDomain(registry: Registered[]): Registered {
  const tool = registry.find((t) => t.name === "add_domain");
  if (!tool) throw new Error("add_domain not registered");
  return tool;
}

test("add_domain takes fqdn and posts it to the tenant domains collection", async () => {
  const { registry, posts } = harness();
  const tool = addDomain(registry);
  expect(Object.keys(tool.schema)).toContain("fqdn");
  expect(Object.keys(tool.schema)).not.toContain("domain_name");

  await tool.cb({ organization: "acme", fqdn: "example.com" });
  expect(posts).toEqual([{ path: "/tenants/T-ACME/domains/", body: { fqdn: "example.com" } }]);
});

test("add_domain forwards the optional binding fields and omits the ones not given", async () => {
  const { registry, posts } = harness();
  const tool = addDomain(registry);
  for (const key of ["application_id", "bound_server_id", "target_port"]) {
    expect(Object.keys(tool.schema), `schema must expose ${key}`).toContain(key);
    expect(tool.schema[key]?.isOptional(), `${key} must be optional`).toBe(true);
  }

  await tool.cb({
    organization: "acme",
    fqdn: "example.com",
    application_id: "APP1",
    bound_server_id: "SRV1",
    target_port: 8080,
  });
  expect(posts[0]?.body).toEqual({
    fqdn: "example.com",
    application_id: "APP1",
    bound_server_id: "SRV1",
    target_port: 8080,
  });

  await tool.cb({ organization: "acme", fqdn: "api.example.com", application_id: "APP1" });
  expect(posts[1]?.body).toEqual({ fqdn: "api.example.com", application_id: "APP1" });
});

function harnessWithGet(getResult: unknown) {
  const { registry, server } = fakeServer();
  const posts: { path: string; body: unknown }[] = [];
  const gets: string[] = [];
  const client = {
    get: (path: string) => { gets.push(path); return Promise.resolve(getResult); },
    post: (path: string, body: unknown) => { posts.push({ path, body }); return Promise.resolve({ ok: true }); },
    put: () => Promise.resolve({}), patch: () => Promise.resolve({}), del: () => Promise.resolve({}),
  } as unknown as McpRegistrationContext["client"];
  const ctx: McpRegistrationContext = {
    client, orgParam: { organization: z.string().min(1) },
    resolveOrg: (): Promise<OrgScope> => Promise.resolve({ tenantId: "T-ACME", client }),
  };
  registerDomainTools(server as never, ctx);
  return { registry, posts, gets };
}

function tool(registry: Registered[], name: string): Registered {
  const t = registry.find((r) => r.name === name);
  if (!t) throw new Error(`${name} not registered`);
  return t;
}

test("get_dns_overview reads the tenant overview and filters by domain_id", async () => {
  const overview = {
    servers: [{ domains: [{ domain_id: "D1", fqdn: "a.example.com", records: [] }] }],
    unbound_domains: [{ domain_id: "D2", fqdn: "b.example.com", records: [] }],
  };
  const { registry, gets } = harnessWithGet(overview);
  const t = tool(registry, "get_dns_overview");
  expect(t.schema["domain_id"]?.isOptional()).toBe(true);
  const one = (await t.cb({ organization: "acme", domain_id: "D2" })) as { content: { text: string }[] };
  expect(gets).toEqual(["/tenants/T-ACME/dns/overview"]);
  expect((JSON.parse(one.content[0]!.text) as Record<string, unknown>).fqdn).toBe("b.example.com");
  const all = (await t.cb({ organization: "acme" })) as { content: { text: string }[] };
  expect((JSON.parse(all.content[0]!.text) as Record<string, unknown>).servers).toHaveLength(1);
});

test("check_domain_health reads the domain and returns its health blocks", async () => {
  const domain = { id: "D1", fqdn: "a.example.com", verification: { status: "verified" }, dns: { status: "ok" }, ssl: { status: "ok" }, registration: { status: "ok" }, secret: "no" };
  const { registry, gets } = harnessWithGet(domain);
  const out = (await tool(registry, "check_domain_health").cb({ organization: "acme", domain_id: "D1" })) as { content: { text: string }[] };
  expect(gets).toEqual(["/tenants/T-ACME/domains/D1"]);
  const parsed = JSON.parse(out.content[0]!.text) as Record<string, unknown>;
  expect(Object.keys(parsed).sort()).toEqual(["dns", "fqdn", "registration", "ssl", "verification"]);
});

test("plan_domain_dns and publish_domain_dns post to the dns routes", async () => {
  const { registry, posts } = harnessWithGet({});
  await tool(registry, "plan_domain_dns").cb({ organization: "acme", domain_id: "D1", proxied: true });
  await tool(registry, "publish_domain_dns").cb({ organization: "acme", domain_id: "D1", plan_hash: "abc" });
  expect(posts).toEqual([
    { path: "/tenants/T-ACME/dns/plan/D1", body: { proxied: true } },
    { path: "/tenants/T-ACME/dns/publish/D1", body: { plan_hash: "abc", proxied: false } },
  ]);
});
