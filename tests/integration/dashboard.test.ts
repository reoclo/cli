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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-dash-"));
  process.env.REOCLO_CACHE_DIR = join(tmp, "cache");
  seedTenantProfile({ configDir: tmp, apiUrl: gw.url, token: gw.token });
});

afterEach(() => {
  gw.stop();
});

function env(): Record<string, string | undefined> {
  return { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
}

test("dashboard (text) prints counts, recent activity, and sparkline", async () => {
  const r = await $`bun run src/index.ts dashboard`.env(env()).quiet();
  const out = r.stdout.toString();
  expect(out).toContain("servers");
  expect(out).toContain("4/5");
  expect(out).toContain("applications");
  expect(out).toContain("Recent activity");
  expect(out).toContain("deploy_succeeded");
  expect(out).toContain("Deploys");
  expect(/[▁▂▃▄▅▆▇█]/.test(out)).toBe(true);
});

test("dashboard -o json dumps the full payload", async () => {
  const r = await $`bun run src/index.ts -o json dashboard`.env(env()).quiet();
  const obj = JSON.parse(r.stdout.toString()) as Record<string, unknown>;
  expect(obj["server_count"]).toBe(5);
  expect(Array.isArray(obj["deploy_history"])).toBe(true);
});
