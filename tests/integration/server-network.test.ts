// tests/integration/server-network.test.ts
import { expect, test, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startFakeGateway, type FakeGateway } from "../helpers/fake-gateway";
import { seedTenantProfile } from "../helpers/seed-profile";

let tmp: string;
let gw: FakeGateway;

beforeEach(() => {
  gw = startFakeGateway();
  tmp = mkdtempSync(join(tmpdir(), "reoclo-srvnet-"));
  process.env.REOCLO_CACHE_DIR = join(tmp, "cache");
  seedTenantProfile({ configDir: tmp, apiUrl: gw.url, token: gw.token });
});

afterEach(() => {
  gw.stop();
});

function env(): Record<string, string | undefined> {
  return { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
}

const writes = (): Array<{ method: string; path: string; body: unknown }> =>
  gw.networkAccess.requests.filter((r) => r.method !== "GET");

test("servers network show prints status, drift, probe and a tunnel command per service", async () => {
  const r = await $`bun run src/index.ts --output text servers network show srv-1 < /dev/null`.env(env()).quiet();
  const out = r.stdout.toString();

  expect(out).toContain("tunnels_only");
  expect(out).toContain("drifted");
  expect(out).toContain("firewall_inactive: ufw is not active");
  expect(out).toContain("last probe: 2026-11-19T10:00:00Z from 203.0.113.20, 0 open of 3 checked");
  expect(out).toContain("reoclo tunnel srv-1 -L 5432:5432");
  expect(out).toContain("reoclo tunnel srv-1 -L 51820:51820 --udp");
  expect(out.split("reoclo tunnel srv-1 -L 5432:5432").length - 1).toBe(1);
});

test("servers network show -o json carries the API fields and the tunnel commands", async () => {
  const r = await $`bun run src/index.ts --output json servers network show srv-1 < /dev/null`.env(env()).quiet();
  const body = JSON.parse(r.stdout.toString()) as Record<string, unknown>;

  expect(body["mode"]).toBe("tunnels_only");
  expect(body["status"]).toBe("drifted");
  expect((body["tunnel_commands"] as Array<{ command: string }>).map((t) => t.command)).toEqual([
    "reoclo tunnel srv-1 -L 5432:5432",
    "reoclo tunnel srv-1 -L 51820:51820 --udp",
  ]);
});

test("servers network set tunnels-only --yes sends the mode and reports applying", async () => {
  const r = await $`bun run src/index.ts --output text servers network set srv-1 tunnels-only --yes < /dev/null`
    .env(env())
    .quiet();

  expect(writes()).toEqual([{ method: "PUT", path: "", body: { mode: "tunnels_only" } }]);
  expect(r.stdout.toString()).toContain("✓ network access set to tunnels-only: srv-1 (applying)");
  expect(r.stdout.toString()).toContain("reoclo servers network show srv-1");
});

test("servers network set public --yes sends public", async () => {
  await $`bun run src/index.ts servers network set srv-1 public --yes < /dev/null`.env(env()).quiet();

  expect(writes()).toEqual([{ method: "PUT", path: "", body: { mode: "public" } }]);
});

test("servers network set without --yes aborts non-interactively and changes nothing", async () => {
  const r = await $`bun run src/index.ts servers network set srv-1 tunnels-only < /dev/null`.env(env()).nothrow().quiet();

  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString()).toContain("--yes");
  expect(writes()).toEqual([]);
});

test("servers network set rejects an unknown mode with exit 2 and no request", async () => {
  const r = await $`bun run src/index.ts servers network set srv-1 bogus --yes < /dev/null`.env(env()).nothrow().quiet();

  expect(r.exitCode).toBe(2);
  expect(gw.networkAccess.requests).toEqual([]);
});

test("servers network set prints the blockers when the API refuses", async () => {
  gw.networkAccess.current["blockers"] = [{ kind: "domain", label: "app.example.com", href: "/domains/1" }];
  gw.networkAccess.conflict = { code: "network_access_blocked", message: "blocked", blockers: [] };

  const r = await $`bun run src/index.ts servers network set srv-1 tunnels-only --yes < /dev/null`.env(env()).nothrow().quiet();

  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("cannot switch to tunnels-only");
  expect(r.stderr.toString()).toContain("domain: app.example.com");
});

test("servers network set explains a runner that is too old", async () => {
  gw.networkAccess.conflict = { code: "runner_outdated", message: "old" };

  const r = await $`bun run src/index.ts servers network set srv-1 tunnels-only --yes < /dev/null`.env(env()).nothrow().quiet();

  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("runner is too old");
});

test("servers network reapply posts to the reapply route", async () => {
  const r = await $`bun run src/index.ts --output text servers network reapply srv-1 < /dev/null`.env(env()).quiet();

  expect(writes()).toEqual([{ method: "POST", path: "reapply", body: undefined }]);
  expect(r.stdout.toString()).toContain("✓ network access is being applied again: srv-1 (applying)");
});
