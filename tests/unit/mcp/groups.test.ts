// Group (stack) tools drive the application-groups API (REO-235). Handlers
// resolve the group by id-or-slug, the deployment by id-or-number, and the
// service by compose_service/slug/id, mirroring `reoclo groups`. Driven
// against the registration function with a recording fake server, like
// domains.test.ts.
import { expect, test } from "bun:test";
import { z } from "zod";
import { registerGroupTools } from "../../../src/mcp/tools/groups";
import type { McpRegistrationContext, OrgScope } from "../../../src/mcp/tools/context";

type Registered = {
  name: string;
  schema: Record<string, z.ZodType>;
  cb: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
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

const GID = "0f0e0d0c-0b0a-4a4b-8c8d-1e1f2a2b3c3d";
const GD_ID = "9f9e9d9c-9b9a-4a4b-8c8d-9e9f8a8b7c7d";

const GROUPS_PATH = "/tenants/T-ACME/application-groups/";
const DETAIL = {
  id: GID,
  slug: "portfolio",
  name: "Portfolio",
  applications: [
    { id: "A-BACK", slug: "portfolio-backend", compose_service: "backend", member_kind: "service" },
    { id: "A-INIT", slug: "portfolio-init", compose_service: "minio-init", member_kind: "task" },
  ],
};

function harness(extra: Record<string, unknown> = {}): {
  registry: Registered[];
  gets: string[];
  posts: { path: string; body: unknown }[];
} {
  const { registry, server } = fakeServer();
  const gets: string[] = [];
  const posts: { path: string; body: unknown }[] = [];
  const responses: Record<string, unknown> = {
    [GROUPS_PATH]: [{ id: GID, slug: "portfolio", name: "Portfolio" }],
    [`${GROUPS_PATH}${GID}`]: DETAIL,
    [`${GROUPS_PATH}${GID}/deployments?limit=100`]: {
      items: [{ id: GD_ID, deployment_number: 9, status: "succeeded" }],
      total: 1,
    },
    ...extra,
  };
  const client = {
    get: (path: string) => {
      gets.push(path);
      return Promise.resolve(path in responses ? responses[path] : {});
    },
    post: (path: string, body?: unknown) => {
      posts.push({ path, body });
      return Promise.resolve({ triggered: 1 });
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
  registerGroupTools(server as never, ctx);
  return { registry, gets, posts };
}

function tool(registry: Registered[], name: string): Registered {
  const found = registry.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

test("registers the group tool family with organization in every schema", () => {
  const { registry } = harness();
  const names = registry.map((t) => t.name);
  expect(names.sort()).toEqual(
    [
      "deploy_application_group",
      "get_application_group",
      "get_group_deployment",
      "list_application_groups",
      "list_group_deployments",
      "list_group_task_runs",
      "redeploy_group_service",
      "run_group_task",
    ].sort(),
  );
  for (const t of registry) {
    expect(Object.keys(t.schema), `${t.name} must expose organization`).toContain("organization");
  }
});

test("list_application_groups reads the tenant collection", async () => {
  const { registry, gets } = harness();
  await tool(registry, "list_application_groups").cb({ organization: "acme" });
  expect(gets).toEqual([GROUPS_PATH]);
});

test("get_application_group resolves a slug through the list, an id directly", async () => {
  const { registry, gets } = harness();
  await tool(registry, "get_application_group").cb({ organization: "acme", group: "portfolio" });
  expect(gets).toEqual([GROUPS_PATH, `${GROUPS_PATH}${GID}`]);

  gets.length = 0;
  await tool(registry, "get_application_group").cb({ organization: "acme", group: GID });
  expect(gets).toEqual([`${GROUPS_PATH}${GID}`]);
});

test("unknown group slug returns a tool error naming the available slugs", async () => {
  const { registry } = harness();
  const result = await tool(registry, "get_application_group").cb({
    organization: "acme",
    group: "nope",
  });
  expect(result.isError).toBe(true);
  const text = result.content[0]?.text ?? "";
  expect(text).toContain("'nope' not found");
  expect(text).toContain("portfolio");
});

test("list_group_deployments forwards pagination to the group's deployments", async () => {
  const { registry, gets } = harness({
    [`${GROUPS_PATH}${GID}/deployments?limit=5`]: { items: [], total: 0 },
  });
  await tool(registry, "list_group_deployments").cb({
    organization: "acme",
    group: "portfolio",
    limit: 5,
  });
  expect(gets).toEqual([GROUPS_PATH, `${GROUPS_PATH}${GID}/deployments?limit=5`]);
});

test("get_group_deployment resolves a deployment number through the list, an id directly", async () => {
  const { registry, gets } = harness();
  await tool(registry, "get_group_deployment").cb({
    organization: "acme",
    group: "portfolio",
    deployment: "9",
  });
  expect(gets).toEqual([
    GROUPS_PATH,
    `${GROUPS_PATH}${GID}/deployments?limit=100`,
    `${GROUPS_PATH}${GID}/deployments/${GD_ID}`,
  ]);

  gets.length = 0;
  await tool(registry, "get_group_deployment").cb({
    organization: "acme",
    group: GID,
    deployment: GD_ID,
  });
  expect(gets).toEqual([`${GROUPS_PATH}${GID}/deployments/${GD_ID}`]);
});

test("get_group_deployment reports an unknown number as a tool error", async () => {
  const { registry } = harness();
  const result = await tool(registry, "get_group_deployment").cb({
    organization: "acme",
    group: "portfolio",
    deployment: "42",
  });
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text ?? "").toContain("'42' not found");
});

test("deploy_application_group posts Deploy All for the resolved group", async () => {
  const { registry, posts } = harness();
  await tool(registry, "deploy_application_group").cb({ organization: "acme", group: "portfolio" });
  expect(posts).toEqual([{ path: `${GROUPS_PATH}${GID}/deploy`, body: undefined }]);
});

test("redeploy_group_service resolves the member by compose service name", async () => {
  const { registry, posts } = harness();
  await tool(registry, "redeploy_group_service").cb({
    organization: "acme",
    group: "portfolio",
    service: "backend",
  });
  expect(posts).toEqual([
    { path: `${GROUPS_PATH}${GID}/services/A-BACK/redeploy`, body: undefined },
  ]);
});

test("redeploy_group_service names the available services when the ref is unknown", async () => {
  const { registry, posts } = harness();
  const result = await tool(registry, "redeploy_group_service").cb({
    organization: "acme",
    group: "portfolio",
    service: "nope",
  });
  expect(result.isError).toBe(true);
  const text = result.content[0]?.text ?? "";
  expect(text).toContain("'nope' not found");
  expect(text).toContain("backend");
  expect(posts).toEqual([]);
});

test("run_group_task targets the task member's run endpoint", async () => {
  const { registry, posts } = harness();
  await tool(registry, "run_group_task").cb({
    organization: "acme",
    group: "portfolio",
    service: "minio-init",
  });
  expect(posts).toEqual([{ path: `${GROUPS_PATH}${GID}/services/A-INIT/run`, body: undefined }]);
});

test("list_group_task_runs filters by resolved member when a service is given", async () => {
  const { registry, gets } = harness({
    [`${GROUPS_PATH}${GID}/task-runs`]: { items: [], total: 0 },
    [`${GROUPS_PATH}${GID}/task-runs?application_id=A-INIT`]: { items: [], total: 0 },
  });
  await tool(registry, "list_group_task_runs").cb({ organization: "acme", group: "portfolio" });
  expect(gets[gets.length - 1]).toBe(`${GROUPS_PATH}${GID}/task-runs`);

  gets.length = 0;
  await tool(registry, "list_group_task_runs").cb({
    organization: "acme",
    group: "portfolio",
    service: "minio-init",
  });
  expect(gets[gets.length - 1]).toBe(`${GROUPS_PATH}${GID}/task-runs?application_id=A-INIT`);
});
