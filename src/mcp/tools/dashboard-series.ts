/**
 * dashboard_series: read the data behind one metric chart.
 *
 * dashboard_get returns lazy panels (metric charts, spend budgets, traffic routes, log
 * tails) as pending with no data. The web app fills metric charts from
 * /tenants/{tenant}/dashboards/series, so this tool calls the same route and adds a
 * per-line summary an agent can read instead of scanning every point.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpRegistrationContext } from "./context";
import { asToolError, asToolResult } from "./common";

/** Raw points are returned only while the whole response stays at or under this many. */
export const MAX_RAW_POINTS = 500;

const RANGES = ["1h", "24h", "7d", "30d"] as const;

const filtersSchema = z
  .object({
    server: z.string().optional(),
    monitor: z.string().optional(),
    application: z.string().optional(),
    pool: z.string().optional(),
    domain: z.string().optional(),
    provider: z.string().optional(),
    result: z.string().optional(),
    pool_kind: z.string().optional(),
  })
  .strict()
  .describe(
    "Filters narrowing the series, as {name: value}. Names: server, monitor, application, pool, domain, provider, result, pool_kind. Each series accepts only some of them: see its `filters` in dashboard_catalog `series`. A filter the series does not allow is refused with a 4xx.",
  );

interface Point {
  t: string;
  v: number | null;
}

interface Line {
  key: string;
  label: string;
  points: Point[];
}

interface SeriesResponse {
  series: string;
  unit: string;
  bucket: string;
  lines: Line[];
}

interface LineSummary {
  key: string;
  label: string;
  point_count: number;
  min: number | null;
  max: number | null;
  last: Point | null;
}

function summarize(line: Line): LineSummary {
  const valued = line.points.filter((p): p is Point & { v: number } => p.v !== null);
  const last = valued.at(-1) ?? null;
  return {
    key: line.key,
    label: line.label,
    point_count: line.points.length,
    min: valued.length > 0 ? Math.min(...valued.map((p) => p.v)) : null,
    max: valued.length > 0 ? Math.max(...valued.map((p) => p.v)) : null,
    last: last && { t: last.t, v: last.v },
  };
}

export function describeSeries(response: SeriesResponse): Record<string, unknown> {
  const summary = response.lines.map(summarize);
  const total = summary.reduce((sum, line) => sum + line.point_count, 0);
  const has_data = summary.some((line) => line.last !== null);
  const base = { series: response.series, unit: response.unit, bucket: response.bucket, has_data };
  if (total > MAX_RAW_POINTS) {
    return { ...base, points_omitted: `${total} points exceed ${MAX_RAW_POINTS}`, lines: summary };
  }
  return {
    ...base,
    lines: response.lines.map((line, i) => ({ ...summary[i], points: line.points })),
  };
}

export function registerDashboardSeriesTool(
  server: McpServer,
  ctx: McpRegistrationContext,
): void {
  server.tool(
    "dashboard_series",
    `Read the data behind one metric chart, to check that a metric chart panel has data. dashboard_get returns lazy panels (every metric chart, plus spend budgets, traffic routes and log tails) as pending with no data, so use this tool for metric charts. Pass a series id from dashboard_catalog \`series\` and the filters its panel config uses (for example server for server.cpu). Returns {series, unit, bucket, has_data, lines}. Each line has key, label, point_count, min, max and last ({t, v}, the newest point with a value), so you can judge whether there is data without reading every point. Lines also carry their raw points ({t, v}) unless the whole response has more than ${MAX_RAW_POINTS} points; then points_omitted says so and only the summaries come back. Empty lines or has_data false mean the chart would be blank. A bad series, filter or range comes back as an error with the API's problems.`,
    {
      ...ctx.orgParam,
      series: z.string().min(1).describe("Series id, from dashboard_catalog `series`, for example server.cpu"),
      range: z.enum(RANGES).default("24h").describe("Time window: 1h, 24h, 7d or 30d. Defaults to 24h."),
      filters: filtersSchema.optional(),
    },
    async ({ series, range, filters, ...args }) => {
      try {
        const { tenantId, client } = await ctx.resolveOrg(args.organization);
        const params = new URLSearchParams({ series, range });
        for (const [name, value] of Object.entries(filters ?? {})) {
          if (value !== undefined) params.set(name, value);
        }
        const response = await client.get<SeriesResponse>(
          `/tenants/${tenantId}/dashboards/series?${params.toString()}`,
        );
        return asToolResult(describeSeries(response));
      } catch (error: unknown) {
        return asToolError(error);
      }
    },
  );
}
