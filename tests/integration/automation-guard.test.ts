import { expect, test, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FakeGateway } from "../helpers/fake-gateway";
import { startFakeGateway } from "../helpers/fake-gateway";
import { seedTenantProfile } from "../helpers/seed-profile";

let tmp: string;
let gw: FakeGateway;

beforeEach(() => {
  gw = startFakeGateway();
  tmp = mkdtempSync(join(tmpdir(), "reoclo-guard-"));
});

afterEach(() => {
  gw.stop();
});

test("automation key is blocked from running 'servers ls' (tenant-only command)", async () => {
  const env = {
    ...process.env,
    REOCLO_CONFIG_DIR: tmp,
    REOCLO_AUTOMATION_KEY: "rk_a_test",   // automation prefix triggers the guard
    REOCLO_API_URL: gw.url,
  };
  const r = await $`bun run src/index.ts servers ls`.env(env).nothrow().quiet();
  expect(r.exitCode).toBe(4);
  expect(r.stderr.toString()).toContain("requires an organization key");
});

test("tenant key is allowed to run 'servers ls'", async () => {
  // Login (writes profile with tenant key)
  seedTenantProfile({ configDir: tmp, apiUrl: gw.url, token: gw.token });

  const env = {
    ...process.env,
    REOCLO_CONFIG_DIR: tmp,
  };
  const r = await $`bun run src/index.ts servers ls`.env(env).quiet();
  expect(r.stdout.toString()).toContain("srv-1");
});
