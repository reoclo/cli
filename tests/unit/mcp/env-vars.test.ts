import { expect, test } from "bun:test";
import { z } from "zod";
import { registerOtherTools } from "../../../src/mcp/tools/other";
import type { McpRegistrationContext, OrgScope } from "../../../src/mcp/tools/context";

type Registered = {
  name: string;
  cb: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
};

function harness(): {
  registry: Registered[];
  gets: string[];
  patches: { path: string; body: unknown }[];
  posts: string[];
} {
  const registry: Registered[] = [];
  const server = {
    tool(name: string, ...rest: unknown[]) {
      registry.push({ name, cb: rest[rest.length - 1] as Registered["cb"] });
    },
  };
  const gets: string[] = [];
  const patches: { path: string; body: unknown }[] = [];
  const posts: string[] = [];
  const client = {
    get: (path: string) => {
      gets.push(path);
      return Promise.resolve([{ key: "API_URL", build_public: true, build_secret: false }]);
    },
    post: (path: string) => {
      posts.push(path);
      return Promise.resolve({});
    },
    put: () => Promise.resolve({}),
    patch: (path: string, body: unknown) => {
      patches.push({ path, body });
      return Promise.resolve([]);
    },
    del: () => Promise.resolve({}),
  } as unknown as McpRegistrationContext["client"];
  const ctx: McpRegistrationContext = {
    client,
    orgParam: { organization: z.string().min(1) },
    resolveOrg: (): Promise<OrgScope> => Promise.resolve({ tenantId: "T-ACME", client }),
  };
  registerOtherTools(server as never, ctx);
  return { registry, gets, patches, posts };
}

function tool(registry: Registered[], name: string): Registered {
  const found = registry.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

const ENV_PATH = "/tenants/T-ACME/applications/A1/env/";

test("set_env_var merges one variable through PATCH on the env collection", async () => {
  const { registry, patches, posts } = harness();
  await tool(registry, "set_env_var").cb({ organization: "acme", application_id: "A1", key: "FOO", value: "bar" });
  expect(posts).toEqual([]);
  expect(patches).toEqual([{ path: ENV_PATH, body: { vars: [{ key: "FOO", value: "bar" }] } }]);
});

test("build_exposure maps to the two API options, and leaving it out sends neither", async () => {
  const { registry, patches } = harness();
  const set = tool(registry, "set_env_var");
  for (const build_exposure of ["public_build_value", "build_secret", "none"]) {
    await set.cb({ organization: "acme", application_id: "A1", key: "K", value: "v", build_exposure });
  }
  expect(patches.map((p) => (p.body as { vars: unknown[] }).vars[0])).toEqual([
    { key: "K", value: "v", build_public: true, build_secret: false },
    { key: "K", value: "v", build_public: false, build_secret: true },
    { key: "K", value: "v", build_public: false, build_secret: false },
  ]);
});

test("secret_project_id stores a reference, reading the same key unless secret_key renames it", async () => {
  const { registry, patches } = harness();
  const set = tool(registry, "set_env_var");
  await set.cb({ organization: "acme", application_id: "A1", key: "TOKEN", secret_project_id: "P1", build_exposure: "build_secret" });
  await set.cb({ organization: "acme", application_id: "A1", key: "CMS", secret_project_id: "P1", secret_key: "TOKEN" });
  expect(patches.map((p) => (p.body as { vars: unknown[] }).vars[0])).toEqual([
    {
      key: "TOKEN",
      source: "reference",
      secret_ref: { project_id: "P1", secret_key: "TOKEN" },
      build_public: false,
      build_secret: true,
    },
    { key: "CMS", source: "reference", secret_ref: { project_id: "P1", secret_key: "TOKEN" } },
  ]);
});

test("set_env_var refuses neither or both of value and secret_project_id without calling the API", async () => {
  const { registry, patches } = harness();
  const set = tool(registry, "set_env_var");
  const neither = await set.cb({ organization: "acme", application_id: "A1", key: "K" });
  const both = await set.cb({ organization: "acme", application_id: "A1", key: "K", value: "v", secret_project_id: "P1" });
  expect(neither.isError).toBe(true);
  expect(both.isError).toBe(true);
  expect(patches).toEqual([]);
});

test("list_env_vars reads the env collection and passes the build options through", async () => {
  const { registry, gets } = harness();
  const result = await tool(registry, "list_env_vars").cb({ organization: "acme", application_id: "A1" });
  expect(gets).toEqual([ENV_PATH]);
  expect(result.content[0]?.text).toContain('"build_public": true');
});
