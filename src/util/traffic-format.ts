// src/util/traffic-format.ts
//
// Types for the traffic read API fields the CLI prints, and the pure helpers
// that turn them into table cells. The API bodies are passed through
// untouched under `-o json`; only what is printed is typed here.

export const TRAFFIC_RANGES = ["15m", "1h", "6h", "24h", "7d", "30d", "90d"] as const;
export type TrafficRange = (typeof TRAFFIC_RANGES)[number];

export const ROUTE_SORTS = ["requests", "errors", "p95", "bytes"] as const;
export type RouteSort = (typeof ROUTE_SORTS)[number];

export interface TrafficMetrics {
  requests: number;
  rps: number;
  errors_5xx: number;
  /** Fraction between 0 and 1. */
  error_rate: number;
  client_errors_4xx: number;
  p50_ms?: number | null;
  p95_ms?: number | null;
  p99_ms?: number | null;
  bytes_out: number;
  bots: number;
}

export interface TrafficSummaryBody {
  current: TrafficMetrics;
  previous: TrafficMetrics;
}

export interface TrafficRouteItem {
  method: string;
  route: string;
  requests: number;
  rps: number;
  error_rate: number;
  p50_ms?: number | null;
  p95_ms?: number | null;
  p99_ms?: number | null;
  bytes_out: number;
}

export interface TrafficRoutesBody {
  items: TrafficRouteItem[];
  other_requests: number;
  not_found_requests: number;
}

const EMPTY = "-";

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function formatRate(perSecond: number): string {
  return perSecond.toFixed(2);
}

/** `fraction` is 0 to 1, as the API sends error_rate. */
export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return EMPTY;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms < 10 ? ms.toFixed(1) : Math.round(ms).toString()} ms`;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[unit] ?? "B"}`;
}

/**
 * Change against the previous period: a signed percentage, "new" when the
 * previous period had nothing, and "-" when there is nothing to compare.
 */
export function formatChange(
  current: number | null | undefined,
  previous: number | null | undefined,
): string {
  if (current === null || current === undefined) return EMPTY;
  if (previous === null || previous === undefined) return EMPTY;
  if (previous === 0) return current === 0 ? EMPTY : "new";
  const pct = ((current - previous) / previous) * 100;
  if (Math.abs(pct) < 0.05) return "0.0%";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

export interface SummaryRow {
  metric: string;
  current: string;
  previous: string;
  change: string;
}

export function summaryRows(current: TrafficMetrics, previous: TrafficMetrics): SummaryRow[] {
  const row = (
    metric: string,
    cur: number | null | undefined,
    prev: number | null | undefined,
    fmt: (n: number) => string,
  ): SummaryRow => ({
    metric,
    current: cur === null || cur === undefined ? EMPTY : fmt(cur),
    previous: prev === null || prev === undefined ? EMPTY : fmt(prev),
    change: formatChange(cur, prev),
  });
  return [
    row("Requests", current.requests, previous.requests, formatCount),
    row("Requests per second", current.rps, previous.rps, formatRate),
    row("Server errors (5xx)", current.errors_5xx, previous.errors_5xx, formatCount),
    row("Error rate", current.error_rate, previous.error_rate, formatPercent),
    row("Client errors (4xx)", current.client_errors_4xx, previous.client_errors_4xx, formatCount),
    row("Latency p50", current.p50_ms, previous.p50_ms, formatMs),
    row("Latency p95", current.p95_ms, previous.p95_ms, formatMs),
    row("Latency p99", current.p99_ms, previous.p99_ms, formatMs),
    row("Bytes out", current.bytes_out, previous.bytes_out, formatBytes),
    row("Bot requests", current.bots, previous.bots, formatCount),
  ];
}

export interface RouteRow {
  method: string;
  route: string;
  requests: string;
  rps: string;
  errors: string;
  p50: string;
  p95: string;
  p99: string;
  bytes: string;
}

export function routeRows(items: readonly TrafficRouteItem[]): RouteRow[] {
  return items.map((r) => ({
    method: r.method,
    route: r.route,
    requests: formatCount(r.requests),
    rps: formatRate(r.rps),
    errors: formatPercent(r.error_rate),
    p50: formatMs(r.p50_ms),
    p95: formatMs(r.p95_ms),
    p99: formatMs(r.p99_ms),
    bytes: formatBytes(r.bytes_out),
  }));
}

/** The footer under the route table, or null when both counts are zero. */
export function routesFooter(body: TrafficRoutesBody): string | null {
  const parts: string[] = [];
  if (body.other_requests > 0) parts.push(`${formatCount(body.other_requests)} on other routes`);
  if (body.not_found_requests > 0) {
    parts.push(`${formatCount(body.not_found_requests)} not found`);
  }
  return parts.length > 0 ? `Not listed: ${parts.join(", ")}` : null;
}
