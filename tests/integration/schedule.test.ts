// tests/integration/schedule.test.ts
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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-sch-"));
  process.env.REOCLO_CACHE_DIR = join(tmp, "cache");
  seedTenantProfile({ configDir: tmp, apiUrl: gw.url, token: gw.token });
});

afterEach(() => {
  gw.stop();
});

function env(): Record<string, string | undefined> {
  return { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
}

test("schedule create → ls → get → update → rm", async () => {
  const created = await $`bun run src/index.ts schedule create --name nightly --type RESTART --schedule CRON --cron "0 3 * * *" --server srv-1`
    .env(env()).quiet();
  expect(created.stdout.toString()).toContain("✓ scheduled operation created:");
  const id = created.stdout.toString().trim().split(": ")[1]!;

  const ls = await $`bun run src/index.ts schedule ls`.env(env()).quiet();
  expect(ls.stdout.toString()).toContain("nightly");

  const got = await $`bun run src/index.ts schedule get ${id} -o json`.env(env()).quiet();
  const op = JSON.parse(got.stdout.toString()) as { id: string };
  expect(op.id).toBe(id);

  const updated = await $`bun run src/index.ts schedule update ${id} --description "off-peak restart"`
    .env(env()).quiet();
  expect(updated.stdout.toString()).toContain("✓ scheduled operation updated:");

  const removed = await $`bun run src/index.ts schedule rm ${id}`.env(env()).quiet();
  expect(removed.stdout.toString()).toContain("✓ scheduled operation removed:");
});

test("schedule ls --status filters", async () => {
  await $`bun run src/index.ts schedule create --name status-filter-probe --type REBOOT --schedule ONCE --at 2026-03-01T00:00:00Z --server srv-1`
    .env(env()).quiet();
  const filtered = await $`bun run src/index.ts schedule ls --status PAUSED`.env(env()).quiet();
  expect(filtered.stdout.toString()).not.toContain("status-filter-probe");
});

test("schedule ls --type filters by operation_type", async () => {
  await $`bun run src/index.ts schedule create --name restart-op --type RESTART --schedule CRON --cron "0 2 * * *" --server srv-1`
    .env(env()).quiet();
  await $`bun run src/index.ts schedule create --name reboot-op --type REBOOT --schedule CRON --cron "0 4 * * *" --server srv-1`
    .env(env()).quiet();
  const filtered = await $`bun run src/index.ts schedule ls --type RESTART`.env(env()).quiet();
  const out = filtered.stdout.toString();
  expect(out).toContain("restart-op");
  expect(out).not.toContain("reboot-op");
});

test("schedule runs --status filter", async () => {
  const created = await $`bun run src/index.ts schedule create --name filter-test --type RESTART --schedule CRON --cron "0 1 * * *" --server srv-1`
    .env(env()).quiet();
  const id = created.stdout.toString().trim().split(": ")[1]!;

  const triggered = await $`bun run src/index.ts schedule trigger ${id}`.env(env()).quiet();
  const runId = triggered.stdout.toString().trim().split("run ")[1]!;

  // SUCCEEDED filter should exclude the RUNNING run
  const filteredOut = await $`bun run src/index.ts schedule runs ${id} --status SUCCEEDED`.env(env()).quiet();
  expect(filteredOut.stdout.toString()).not.toContain(runId);

  // RUNNING filter should include it
  const filteredIn = await $`bun run src/index.ts schedule runs ${id} --status RUNNING`.env(env()).quiet();
  expect(filteredIn.stdout.toString()).toContain(runId);
});

test("schedule pause → resume → trigger → runs → run", async () => {
  const created = await $`bun run src/index.ts schedule create --name lifecycle --type RESTART --schedule CRON --cron "0 1 * * *" --server srv-1`
    .env(env()).quiet();
  const id = created.stdout.toString().trim().split(": ")[1]!;

  const paused = await $`bun run src/index.ts schedule pause ${id}`.env(env()).quiet();
  expect(paused.stdout.toString()).toContain("✓ scheduled operation paused:");

  const resumed = await $`bun run src/index.ts schedule resume ${id}`.env(env()).quiet();
  expect(resumed.stdout.toString()).toContain("✓ scheduled operation resumed:");

  const triggered = await $`bun run src/index.ts schedule trigger ${id}`.env(env()).quiet();
  expect(triggered.stdout.toString()).toContain("✓ triggered: run ");
  const runId = triggered.stdout.toString().trim().split("run ")[1]!;

  const runs = await $`bun run src/index.ts schedule runs ${id}`.env(env()).quiet();
  expect(runs.stdout.toString()).toContain(runId);

  const run = await $`bun run src/index.ts schedule run ${id} ${runId}`.env(env()).quiet();
  expect(run.stdout.toString()).toContain("output:");
  expect(run.stdout.toString()).toContain("step 1 ok");
});
