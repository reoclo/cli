// tests/integration/schedule.test.ts
import { expect, test, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startFakeGateway, type FakeGateway } from "../helpers/fake-gateway";

let tmp: string;
let gw: FakeGateway;

beforeEach(async () => {
  gw = startFakeGateway();
  tmp = mkdtempSync(join(tmpdir(), "reoclo-sch-"));
  process.env.REOCLO_CACHE_DIR = join(tmp, "cache");
  await $`bun run src/index.ts login --token ${gw.token} --api ${gw.url} --no-keyring`.env({
    ...process.env,
    REOCLO_CONFIG_DIR: tmp,
    REOCLO_CACHE_DIR: join(tmp, "cache"),
  }).quiet();
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
  await $`bun run src/index.ts schedule create --name a --type REBOOT --schedule ONCE --at 2026-03-01T00:00:00Z --server srv-1`
    .env(env()).quiet();
  const filtered = await $`bun run src/index.ts schedule ls --status PAUSED`.env(env()).quiet();
  expect(filtered.stdout.toString()).not.toContain("\na ");
});
