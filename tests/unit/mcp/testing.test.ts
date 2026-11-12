import { expect, test } from "bun:test";
import { z } from "zod";
import { registerTestingTools } from "../../../src/mcp/tools/testing";
import type { McpRegistrationContext, OrgScope } from "../../../src/mcp/tools/context";
import { FakeApi } from "../../helpers/fake-api";

type Registered = { name: string; cb: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> };

const T = "T-ACME";
const RUN_ID = "22222222-2222-2222-2222-222222222222";
const JOB_ID = "33333333-3333-3333-3333-333333333333";
const REPO_ID = "11111111-1111-1111-1111-111111111111";
const POOL_ID = "44444444-4444-4444-4444-444444444444";

function harness(): { registry: Registered[]; api: FakeApi } {
  const registry: Registered[] = [];
  const server = {
    tool(name: string, ...rest: unknown[]) {
      registry.push({ name, cb: rest[rest.length - 1] as Registered["cb"] });
    },
  };
  const api = new FakeApi()
    .on("GET", `/tenants/${T}/repositories/`, { items: [{ id: REPO_ID, full_name: "acme/web", name: "web" }] })
    .on("GET", `/tenants/${T}/test-pools`, { items: [{ id: POOL_ID, slug: "ci", name: "CI" }], total: 1, skip: 0, limit: 100 })
    .on("GET", `/tenants/${T}/test-pools/${POOL_ID}`, { id: POOL_ID })
    .on("GET", `/tenants/${T}/test-pools/${POOL_ID}/machines`, { items: [] })
    .on("GET", `/tenants/${T}/repositories/${REPO_ID}/tests`, { tests_enabled: true, definitions: [] })
    .on("POST", `/tenants/${T}/repositories/${REPO_ID}/tests/refresh`, { tests_enabled: true, definitions: [] })
    .on("PATCH", `/tenants/${T}/repositories/${REPO_ID}/test-settings`, { tests_enabled: true })
    .on("POST", `/tenants/${T}/repositories/${REPO_ID}/tests/unit/runs`, { id: RUN_ID, number: 3 })
    .on("GET", `/tenants/${T}/test-runs`, (req) => ({ items: req.query.get("cursor") === "4" ? [{ id: RUN_ID, number: 3 }] : [], next_cursor: null }))
    .on("GET", `/tenants/${T}/test-runs/${RUN_ID}`, { id: RUN_ID, state: "running", jobs: [{ id: JOB_ID, key: "build", state: "running" }] })
    .on("GET", `/tenants/${T}/test-runs/${RUN_ID}/jobs/${JOB_ID}/logs`, { items: [], next_after_seq: 9 })
    .on("POST", `/tenants/${T}/test-runs/${RUN_ID}/cancel`, { state: "cancelling" })
    .on("POST", `/tenants/${T}/test-runs/${RUN_ID}/rerun`, { id: "new" })
    .on("POST", `/tenants/${T}/tests/validate`, { valid: true, error: null, test: null });
  const client = api as unknown as McpRegistrationContext["client"];
  const ctx: McpRegistrationContext = {
    client,
    orgParam: { organization: z.string().min(1) },
    resolveOrg: (): Promise<OrgScope> => Promise.resolve({ tenantId: T, client }),
  };
  registerTestingTools(server as never, ctx);
  return { registry, api };
}

const call = (registry: Registered[], name: string, args: Record<string, unknown>): ReturnType<Registered["cb"]> => {
  const found = registry.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found.cb({ organization: "acme", ...args });
};

test("the test server tools are registered", () => {
  expect(harness().registry.map((t) => t.name).sort()).toEqual([
    "cancel_test_run",
    "get_test_job_logs",
    "get_test_pool",
    "get_test_run",
    "list_test_pool_machines",
    "list_test_pools",
    "list_test_runs",
    "list_tests",
    "rerun_test_run",
    "set_repository_tests",
    "start_test_run",
    "validate_test_file",
  ]);
});

test("pool tools take a slug and reach the pool and machine routes", async () => {
  const { registry, api } = harness();
  await call(registry, "list_test_pools", { limit: 5 });
  await call(registry, "get_test_pool", { pool: "ci" });
  await call(registry, "list_test_pool_machines", { pool: "ci", limit: 10 });
  expect(api.requests.filter((r) => r.path !== `/tenants/${T}/test-pools` || r.query.has("limit")).map((r) => `${r.path}?${r.query.toString()}`)).toEqual([
    `/tenants/${T}/test-pools?limit=5`,
    `/tenants/${T}/test-pools?skip=0&limit=100`,
    `/tenants/${T}/test-pools/${POOL_ID}?`,
    `/tenants/${T}/test-pools?skip=0&limit=100`,
    `/tenants/${T}/test-pools/${POOL_ID}/machines?limit=10`,
  ]);
});

test("repository tools resolve owner/name and enable, refresh and start a run", async () => {
  const { registry, api } = harness();
  await call(registry, "list_tests", { repository: "acme/web", refresh: true });
  await call(registry, "set_repository_tests", { repository: "acme/web", enabled: true });
  await call(registry, "start_test_run", { repository: "acme/web", test: "unit", ref: "main", sha: "abcdef1" });
  await call(registry, "start_test_run", { repository: "acme/web", test: "unit" });
  expect(api.calls("POST", `/tenants/${T}/repositories/${REPO_ID}/tests/refresh`)).toHaveLength(1);
  expect(api.calls("PATCH", `/tenants/${T}/repositories/${REPO_ID}/test-settings`)[0]?.body).toEqual({ enabled: true });
  const starts = api.calls("POST", `/tenants/${T}/repositories/${REPO_ID}/tests/unit/runs`).map((r) => r.body);
  expect(starts).toEqual([{ ref: "main", sha: "abcdef1" }, {}]);
});

test("run tools accept a run number and cancel, rerun and read the run", async () => {
  const { registry, api } = harness();
  await call(registry, "get_test_run", { run: "3" });
  await call(registry, "cancel_test_run", { run: RUN_ID });
  await call(registry, "rerun_test_run", { run: RUN_ID });
  expect(api.calls("GET", `/tenants/${T}/test-runs`)[0]?.query.get("cursor")).toBe("4");
  expect(api.calls("GET", `/tenants/${T}/test-runs/${RUN_ID}`)).toHaveLength(1);
  expect(api.calls("POST", `/tenants/${T}/test-runs/${RUN_ID}/cancel`)).toHaveLength(1);
  expect(api.calls("POST", `/tenants/${T}/test-runs/${RUN_ID}/rerun`)).toHaveLength(1);
});

test("list_test_runs filters by repository, test, state and cursor", async () => {
  const { registry, api } = harness();
  await call(registry, "list_test_runs", { repository: "acme/web", test: "unit", state: "failed", cursor: 8 });
  const query = api.calls("GET", `/tenants/${T}/test-runs`)[0]?.query;
  expect(Object.fromEntries(query ?? [])).toEqual({ repository_id: REPO_ID, test: "unit", state: "failed", cursor: "8" });
});

test("get_test_job_logs finds the job by key and returns the cursor to read on from", async () => {
  const { registry, api } = harness();
  const result = await call(registry, "get_test_job_logs", { run: RUN_ID, job: "build", after_seq: 4, limit: 50 });
  const logs = api.calls("GET", `/tenants/${T}/test-runs/${RUN_ID}/jobs/${JOB_ID}/logs`)[0]?.query;
  expect(Object.fromEntries(logs ?? [])).toEqual({ after_seq: "4", limit: "50" });
  expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({ job: "build", job_state: "running", next_after_seq: 9 });
  expect((await call(registry, "get_test_job_logs", { run: RUN_ID })).isError).toBeUndefined();
  expect((await call(registry, "get_test_job_logs", { run: RUN_ID, job: "nope" })).isError).toBe(true);
});

test("validate_test_file posts the name and the file text", async () => {
  const { registry, api } = harness();
  await call(registry, "validate_test_file", { name: "unit", content: "version: 1\n" });
  expect(api.calls("POST", `/tenants/${T}/tests/validate`)[0]?.body).toEqual({ name: "unit", content: "version: 1\n" });
});
