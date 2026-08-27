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
