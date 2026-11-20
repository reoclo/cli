import { expect, test } from "bun:test";
import { z } from "zod";
import { ApiError } from "../../../src/client/errors";
import { MAX_RAW_POINTS, registerDashboardSeriesTool } from "../../../src/mcp/tools/dashboard-series";
import type { McpRegistrationContext, OrgScope } from "../../../src/mcp/tools/context";

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };
type Registered = {
  name: string;
  schema: Record<string, z.ZodType>;
  cb: (args: Record<string, unknown>) => Promise<ToolResult>;
};

const T = "T-ACME";
const S = "f6e09773-5e45-48fe-98f2-1ec7ec00c99f";

function harness(respond: () => Promise<unknown>): { tool: Registered; paths: string[] } {
  const registry: Registered[] = [];
  const server = {
    tool(name: string, ...rest: unknown[]) {
      const cb = rest[rest.length - 1] as Registered["cb"];
      const schema = rest.find((r) => typeof r === "object" && r !== null) as Registered["schema"];
      registry.push({ name, schema, cb });
    },
  };
  const paths: string[] = [];
  const client = {
    get: (path: string): Promise<unknown> => {
      paths.push(path);
      return respond();
    },
  } as unknown as McpRegistrationContext["client"];
  const ctx: McpRegistrationContext = {
    client,
    orgParam: { organization: z.string().min(1) },
    resolveOrg: (): Promise<OrgScope> => Promise.resolve({ tenantId: T, client }),
  };
  registerDashboardSeriesTool(server as never, ctx);
  const tool = registry.find((t) => t.name === "dashboard_series");
  if (!tool) throw new Error("dashboard_series not registered");
  return { tool, paths };
}

const body = (result: ToolResult): Record<string, unknown> => JSON.parse(result.content[0]?.text ?? "") as Record<string, unknown>;

const response = {
  series: "server.cpu",
  unit: "percent",
  bucket: "15m",
  lines: [
    {
      key: S,
      label: "Production Server",
      points: [
        { t: "2026-11-19T19:30:00Z", v: 14 },
        { t: "2026-11-19T19:45:00Z", v: 2 },
        { t: "2026-11-19T20:00:00Z", v: null },
        { t: "2026-11-19T20:15:00Z", v: 9 },
        { t: "2026-11-19T20:30:00Z", v: null },
      ],
    },
    { key: "empty", label: "Idle", points: [] },
  ],
};

test("it requests the series route with the filters as query params", async () => {
  const { tool, paths } = harness(() => Promise.resolve(response));
  await tool.cb({ organization: "acme", series: "server.cpu", range: "7d", filters: { server: S, pool_kind: "build" } });
  expect(paths).toEqual([`/tenants/${T}/dashboards/series?series=server.cpu&range=7d&server=${S}&pool_kind=build`]);
});

test("without filters only series and range are sent", async () => {
  const { tool, paths } = harness(() => Promise.resolve(response));
  await tool.cb({ organization: "acme", series: "traffic.requests", range: "24h" });
  expect(paths).toEqual([`/tenants/${T}/dashboards/series?series=traffic.requests&range=24h`]);
});

test("each line is summarized over the points that carry a value, and the raw points come back", async () => {
  const { tool } = harness(() => Promise.resolve(response));
  const out = body(await tool.cb({ organization: "acme", series: "server.cpu", range: "24h" }));
  expect(out).toMatchObject({ series: "server.cpu", unit: "percent", bucket: "15m", has_data: true });
  expect(out.lines).toEqual([
    {
      key: S,
      label: "Production Server",
      point_count: 5,
      min: 2,
      max: 14,
      last: { t: "2026-11-19T20:15:00Z", v: 9 },
      points: response.lines[0]?.points,
    },
    { key: "empty", label: "Idle", point_count: 0, min: null, max: null, last: null, points: [] },
  ]);
});

test("a series with no valued points reports has_data false", async () => {
  const { tool } = harness(() => Promise.resolve({ ...response, lines: [response.lines[1]] }));
  const out = body(await tool.cb({ organization: "acme", series: "server.cpu", range: "1h" }));
  expect(out.has_data).toBe(false);
});

test("above the point cap the raw points are dropped and the summaries stay", async () => {
  const points = Array.from({ length: MAX_RAW_POINTS + 1 }, (_, i) => ({ t: `t${i}`, v: i }));
  const { tool } = harness(() => Promise.resolve({ ...response, lines: [{ key: "k", label: "L", points }] }));
  const out = body(await tool.cb({ organization: "acme", series: "server.cpu", range: "30d" }));
  expect(out.points_omitted).toBeDefined();
  expect(out.lines).toEqual([
    { key: "k", label: "L", point_count: MAX_RAW_POINTS + 1, min: 0, max: MAX_RAW_POINTS, last: { t: `t${MAX_RAW_POINTS}`, v: MAX_RAW_POINTS } },
  ]);
});

test("an API refusal comes back as a tool error with the status", async () => {
  const path = `/tenants/${T}/dashboards/series`;
  const { tool } = harness(() => Promise.reject(new ApiError(422, "filter not allowed", path)));
  const result = await tool.cb({ organization: "acme", series: "server.cpu", range: "24h", filters: { pool: "x" } });
  expect(result.isError).toBe(true);
  expect(body(result)).toMatchObject({ status: 422, message: "filter not allowed" });
});

test("input rejects an unknown range and an unknown filter name", () => {
  const { tool } = harness(() => Promise.resolve(response));
  const schema = z.object(tool.schema);
  const ok = { organization: "acme", series: "server.cpu", range: "24h", filters: { server: S } };
  expect(schema.safeParse(ok).success).toBe(true);
  expect(schema.safeParse({ ...ok, range: "90d" }).success).toBe(false);
  expect(schema.safeParse({ ...ok, filters: { region: "eu" } }).success).toBe(false);
});
