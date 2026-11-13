import { expect, test } from "bun:test";
import { z } from "zod";
import { ApiError } from "../../../src/client/errors";
import { registerDashboardTools } from "../../../src/mcp/tools/dashboards";
import type { McpRegistrationContext, OrgScope } from "../../../src/mcp/tools/context";

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };
type Registered = {
  name: string;
  schema: Record<string, z.ZodType>;
  cb: (args: Record<string, unknown>) => Promise<ToolResult>;
};
type Recorded = { method: string; path: string; body?: unknown };

const T = "T-ACME";
const D = "11111111-1111-1111-1111-111111111111";
const R = "22222222-2222-2222-2222-222222222222";
const BASE = `/tenants/${T}/dashboards`;

function harness(fail?: ApiError): { registry: Registered[]; calls: Recorded[] } {
  const registry: Registered[] = [];
  const server = {
    tool(name: string, ...rest: unknown[]) {
      const cb = rest[rest.length - 1] as Registered["cb"];
      const schema = rest.find((r) => typeof r === "object" && r !== null) as Registered["schema"];
      registry.push({ name, schema, cb });
    },
  };
  const calls: Recorded[] = [];
  const record =
    (method: string) =>
    (path: string, body?: unknown): Promise<unknown> => {
      calls.push({ method, path, body });
      return fail ? Promise.reject(fail) : Promise.resolve({ ok: method });
    };
  const client = {
    get: record("GET"),
    post: record("POST"),
    put: record("PUT"),
    patch: record("PATCH"),
    del: (path: string) => record("DELETE")(path).then(() => undefined),
  } as unknown as McpRegistrationContext["client"];
  const ctx: McpRegistrationContext = {
    client,
    orgParam: { organization: z.string().min(1) },
    resolveOrg: (): Promise<OrgScope> => Promise.resolve({ tenantId: T, client }),
  };
  registerDashboardTools(server as never, ctx);
  return { registry, calls };
}

const call = (registry: Registered[], name: string, args: Record<string, unknown>): Promise<ToolResult> => {
  const found = registry.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found.cb({ organization: "acme", ...args });
};

const panels = [{ type: "fleet-health", layout: { x: 0, y: 0, w: 6, h: 4 } }, { type: "recent-deployments" }];

test("the dashboard tools are registered", () => {
  expect(harness().registry.map((t) => t.name).sort()).toEqual([
    "dashboard_assign",
    "dashboard_catalog",
    "dashboard_create",
    "dashboard_delete",
    "dashboard_get",
    "dashboard_set_default",
    "dashboard_templates",
    "dashboard_unassign",
    "dashboard_update",
    "dashboard_validate",
    "dashboards_list",
  ]);
});

test("read tools call the library routes", async () => {
  const { registry, calls } = harness();
  await call(registry, "dashboards_list", {});
  await call(registry, "dashboard_get", { dashboard_id: D });
  await call(registry, "dashboard_catalog", {});
  await call(registry, "dashboard_templates", {});
  expect(calls).toEqual([
    { method: "GET", path: `${BASE}/`, body: undefined },
    { method: "GET", path: `${BASE}/${D}`, body: undefined },
    { method: "GET", path: `${BASE}/catalog`, body: undefined },
    { method: "GET", path: `${BASE}/templates`, body: undefined },
  ]);
});

test("create sends only the fields given and returns the API response", async () => {
  const { registry, calls } = harness();
  const blank = await call(registry, "dashboard_create", { name: "Ops" });
  await call(registry, "dashboard_create", { template_id: "fleet", visibility: { roles: [R] } });
  await call(registry, "dashboard_create", { name: "Full", panels });
  expect(JSON.parse(blank.content[0]?.text ?? "")).toEqual({ ok: "POST" });
  expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
    ["POST", `${BASE}/`, { name: "Ops" }],
    ["POST", `${BASE}/`, { template_id: "fleet", visibility: { roles: [R] } }],
    ["POST", `${BASE}/`, { name: "Full", panels }],
  ]);
});

test("validate posts a create body, or an update body with dashboard_id", async () => {
  const { registry, calls } = harness();
  await call(registry, "dashboard_validate", { name: "Ops", panels });
  await call(registry, "dashboard_validate", { dashboard_id: D, name: "Ops", panels: [] });
  expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
    ["POST", `${BASE}/validate`, { name: "Ops", panels }],
    ["POST", `${BASE}/validate`, { dashboard_id: D, name: "Ops", panels: [] }],
  ]);
});

test("update replaces the dashboard with PUT", async () => {
  const { registry, calls } = harness();
  await call(registry, "dashboard_update", { dashboard_id: D, name: "Ops", visibility: "everyone", panels });
  expect(calls).toEqual([
    { method: "PUT", path: `${BASE}/${D}`, body: { name: "Ops", panels, visibility: "everyone" } },
  ]);
});

test("delete answers {deleted: true} when the API returns no body", async () => {
  const { registry, calls } = harness();
  const result = await call(registry, "dashboard_delete", { dashboard_id: D });
  expect(calls).toEqual([{ method: "DELETE", path: `${BASE}/${D}`, body: undefined }]);
  expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({ deleted: true });
});

test("assign, unassign and default use the assignment and default routes", async () => {
  const { registry, calls } = harness();
  await call(registry, "dashboard_assign", { role_id: R, dashboard_id: D, locked: true });
  await call(registry, "dashboard_unassign", { role_id: R });
  await call(registry, "dashboard_set_default", { dashboard_id: D });
  await call(registry, "dashboard_set_default", { dashboard_id: null });
  expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
    ["PUT", `${BASE}/assignments/${R}`, { dashboard_id: D, locked: true }],
    ["DELETE", `${BASE}/assignments/${R}`, undefined],
    ["PUT", `${BASE}/default`, { dashboard_id: D }],
    ["PUT", `${BASE}/default`, { dashboard_id: null }],
  ]);
});

const problems = [{ path: "panels[1].layout", code: "overlap", message: "Overlaps panel 0." }];
const detail = { message: "The dashboard has problems.", problems };

test.each([
  ["the CLI client, which keeps the raw body", JSON.stringify({ detail })],
  ["the hosted client, which keeps only the detail", JSON.stringify(detail)],
])("a 422 from %s returns the problems as a list", async (_name, message) => {
  const { registry } = harness(new ApiError(422, message, `${BASE}/`));
  const result = await call(registry, "dashboard_create", { name: "Ops", panels });
  expect(result.isError).toBe(true);
  const body = JSON.parse(result.content[0]?.text ?? "") as { status: number; problems: unknown };
  expect(body.status).toBe(422);
  expect(body.problems).toEqual(problems);
});

test("other refusals return the API message", async () => {
  const { registry } = harness(new ApiError(409, "Dashboard limit reached", `${BASE}/`));
  const result = await call(registry, "dashboard_create", { name: "Ops" });
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0]?.text ?? "")).toMatchObject({ status: 409, message: "Dashboard limit reached" });
});

test("panel input rejects a layout outside the 12-column grid", () => {
  const { registry } = harness();
  const create = registry.find((t) => t.name === "dashboard_create");
  const schema = z.object(create?.schema ?? {});
  const bad = { organization: "acme", name: "Ops", panels: [{ type: "fleet-health", layout: { x: 0, y: 0, w: 13, h: 2 } }] };
  expect(schema.safeParse(bad).success).toBe(false);
  expect(schema.safeParse({ organization: "acme", name: "Ops", panels }).success).toBe(true);
});
