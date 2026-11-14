import { afterEach, beforeEach, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startFakeGateway, type FakeGateway } from "../helpers/fake-gateway";
import { seedTenantProfile } from "../helpers/seed-profile";

const APP_ID = "00000000-0000-0000-0000-00000000cccc";

let tmp: string;
let gw: FakeGateway;

beforeEach(() => {
  gw = startFakeGateway();
  tmp = mkdtempSync(join(tmpdir(), "reoclo-traffic-"));
  seedTenantProfile({ configDir: tmp, apiUrl: gw.url, token: gw.token });
});

afterEach(() => {
  gw.stop();
});

function env(): Record<string, string | undefined> {
  return { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
}

function lastQuery(): { path: string; params: URLSearchParams } {
  const raw = gw.trafficRequests.at(-1) ?? "";
  const [path = "", search = ""] = raw.split("?");
  return { path, params: new URLSearchParams(search) };
}

test("traffic summary prints the headline numbers and the change against the previous period", async () => {
  const r = await $`bun run src/index.ts traffic summary --app app-1`.env(env()).quiet();
  const out = r.stdout.toString();
  expect(out).toContain("Traffic for app-1, last 1h");
  expect(out).toContain("Requests");
  expect(out).toContain("1,200");
  expect(out).toContain("+20.0%");
  expect(out).toContain("new");
  expect(out).toContain("1.00%");
  expect(out).toContain("5.0 MB");
  const { path, params } = lastQuery();
  expect(path).toBe(`/tenants/${gw.tenantId}/traffic/summary`);
  expect(params.get("application_id")).toBe(APP_ID);
  expect(params.get("range")).toBe("1h");
});

test("traffic summary -o json prints the API body unchanged", async () => {
  const r = await $`bun run src/index.ts -o json traffic summary --domain example.com --range 7d`
    .env(env())
    .quiet();
  const body = JSON.parse(r.stdout.toString()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["current", "deploys", "previous", "series"]);
  expect((body["current"] as Record<string, unknown>)["page_loads"]).toBe(0);
  const { params } = lastQuery();
  expect(params.get("domain_id")).toBe("dom-1");
  expect(params.get("range")).toBe("7d");
});

test("traffic summary passes the route filter through", async () => {
  const r = await $`bun run src/index.ts traffic summary --app app-1 --route /users/:id --method get`
    .env(env())
    .quiet();
  expect(r.stdout.toString()).toContain("GET /users/:id on app-1");
  const { params } = lastQuery();
  expect(params.get("route")).toBe("/users/:id");
  expect(params.get("method")).toBe("GET");
});

test("traffic summary refuses a route without a method", async () => {
  const r = await $`bun run src/index.ts traffic summary --app app-1 --route /users/:id`
    .env(env())
    .nothrow()
    .quiet();
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("--route and --method go together");
  expect(gw.trafficRequests).toEqual([]);
});

test("traffic commands need a subject", async () => {
  for (const sub of ["summary", "routes", "watch"]) {
    const r = await $`bun run src/index.ts traffic ${sub}`.env(env()).nothrow().quiet();
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("pass --app <id|name> or --domain <fqdn|id>");
  }
  expect(gw.trafficRequests).toEqual([]);
});

test("traffic commands refuse both subjects", async () => {
  for (const sub of ["summary", "routes", "watch"]) {
    const r = await $`bun run src/index.ts traffic ${sub} --app app-1 --domain example.com`
      .env(env())
      .nothrow()
      .quiet();
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("pass only one of --app and --domain");
  }
  expect(gw.trafficRequests).toEqual([]);
});

test("traffic summary rejects an unknown range", async () => {
  const r = await $`bun run src/index.ts traffic summary --app app-1 --range 2h`
    .env(env())
    .nothrow()
    .quiet();
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("invalid --range");
});

test("traffic routes prints a table and the routes it leaves out", async () => {
  const r = await $`bun run src/index.ts traffic routes --app app-1 --sort p95 --limit 10 --range 24h`
    .env(env())
    .quiet();
  const out = r.stdout.toString();
  expect(out).toContain("METHOD");
  expect(out).toContain("/users/:id");
  expect(out).toContain("/orders");
  expect(out).toContain("4.00%");
  expect(out).toContain("Not listed: 7 on other routes, 3 not found");
  const { path, params } = lastQuery();
  expect(path).toBe(`/tenants/${gw.tenantId}/traffic/routes`);
  expect(params.get("sort")).toBe("p95");
  expect(params.get("limit")).toBe("10");
  expect(params.get("range")).toBe("24h");
});

test("traffic routes -o json prints the API body unchanged", async () => {
  const r = await $`bun run src/index.ts -o json traffic routes --domain example.com`.env(env()).quiet();
  const body = JSON.parse(r.stdout.toString()) as { items: unknown[]; other_requests: number };
  expect(body.items).toHaveLength(2);
  expect(body.other_requests).toBe(7);
  expect(lastQuery().params.get("domain_id")).toBe("dom-1");
});

test("traffic routes rejects a limit past the API cap", async () => {
  const r = await $`bun run src/index.ts traffic routes --app app-1 --limit 500`
    .env(env())
    .nothrow()
    .quiet();
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("invalid --limit");
});

async function watchUntilFirstFrame(
  args: string[],
  frameReady: (output: string) => boolean,
): Promise<{ output: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: env(),
  });
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  let output = "";
  while (!frameReady(output)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    output += decoder.decode(chunk.value);
  }
  proc.kill("SIGINT");
  const exitCode = await proc.exited;
  return { output, exitCode };
}

test("traffic watch stops cleanly on SIGINT in piped text mode", async () => {
  const { output, exitCode } = await watchUntilFirstFrame(
    ["traffic", "watch", "--app", "app-1", "--interval", "60"],
    (o) => o.includes("Bot requests"),
  );
  expect(exitCode).toBe(0);
  expect(output).toContain("Traffic for app-1, last 15m");
  expect(output).not.toContain("\x1b[");
  expect(lastQuery().params.get("range")).toBe("15m");
}, 30_000);

test("traffic watch -o json emits one body per line and stops on SIGINT", async () => {
  const { output, exitCode } = await watchUntilFirstFrame(
    ["-o", "json", "traffic", "watch", "--domain", "example.com", "--interval", "60"],
    (o) => o.includes("\n"),
  );
  expect(exitCode).toBe(0);
  const frame = JSON.parse(output.split("\n")[0] ?? "") as { current: { requests: number } };
  expect(frame.current.requests).toBe(1200);
}, 30_000);
