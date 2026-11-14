import { expect, test } from "bun:test";
import {
  formatBytes,
  formatChange,
  formatMs,
  formatPercent,
  routeRows,
  routesFooter,
  summaryRows,
  type TrafficMetrics,
} from "../../../src/util/traffic-format";

const METRICS: TrafficMetrics = {
  requests: 1234567,
  rps: 12.345,
  errors_5xx: 10,
  error_rate: 0.0081,
  client_errors_4xx: 0,
  p50_ms: 8.25,
  p95_ms: 480,
  p99_ms: 2500,
  bytes_out: 3 * 1024 * 1024,
  bots: 0,
};

test("formatChange compares against the previous period", () => {
  expect(formatChange(120, 100)).toBe("+20.0%");
  expect(formatChange(75, 100)).toBe("-25.0%");
  expect(formatChange(100, 100)).toBe("0.0%");
  expect(formatChange(5, 0)).toBe("new");
  expect(formatChange(0, 0)).toBe("-");
  expect(formatChange(null, 100)).toBe("-");
  expect(formatChange(100, undefined)).toBe("-");
});

test("formatMs switches to seconds at one second and shows a gap for no data", () => {
  expect(formatMs(8.25)).toBe("8.3 ms");
  expect(formatMs(480.4)).toBe("480 ms");
  expect(formatMs(2500)).toBe("2.50 s");
  expect(formatMs(null)).toBe("-");
  expect(formatMs(undefined)).toBe("-");
});

test("formatBytes and formatPercent scale their units", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  expect(formatPercent(0.0081)).toBe("0.81%");
});

test("summaryRows lays out current, previous and change per metric", () => {
  const rows = summaryRows(METRICS, { ...METRICS, requests: 1000000, p95_ms: null });
  expect(rows[0]).toEqual({
    metric: "Requests",
    current: "1,234,567",
    previous: "1,000,000",
    change: "+23.5%",
  });
  const p95 = rows.find((r) => r.metric === "Latency p95");
  expect(p95).toEqual({ metric: "Latency p95", current: "480 ms", previous: "-", change: "-" });
});

test("routeRows formats a route and routesFooter names what the table leaves out", () => {
  const [row] = routeRows([
    {
      method: "GET",
      route: "/users/:id",
      requests: 900,
      rps: 0.25,
      error_rate: 0.005,
      p50_ms: 30,
      p95_ms: null,
      bytes_out: 2048,
    },
  ]);
  expect(row).toEqual({
    method: "GET",
    route: "/users/:id",
    requests: "900",
    rps: "0.25",
    errors: "0.50%",
    p50: "30 ms",
    p95: "-",
    p99: "-",
    bytes: "2.0 KB",
  });
  expect(routesFooter({ items: [], other_requests: 0, not_found_requests: 0 })).toBeNull();
  expect(routesFooter({ items: [], other_requests: 1500, not_found_requests: 0 })).toBe(
    "Not listed: 1,500 on other routes",
  );
});
