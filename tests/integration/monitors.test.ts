// tests/integration/monitors.test.ts
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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-mon-"));
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

test("monitors create → ls → get → pause → resume → rm", async () => {
  const created = await $`bun run src/index.ts monitors create --name api --url https://example.com`
    .env(env()).quiet();
  expect(created.stdout.toString()).toContain("✓ monitor created:");
  const id = created.stdout.toString().trim().split(": ")[1]!;

  const ls = await $`bun run src/index.ts monitors ls`.env(env()).quiet();
  expect(ls.stdout.toString()).toContain("api");

  const got = await $`bun run src/index.ts monitors get ${id}`.env(env()).quiet();
  expect(got.stdout.toString()).toContain(id);

  const paused = await $`bun run src/index.ts monitors pause ${id}`.env(env()).quiet();
  expect(paused.stdout.toString()).toContain("✓ monitor paused:");

  const resumed = await $`bun run src/index.ts monitors resume ${id}`.env(env()).quiet();
  expect(resumed.stdout.toString()).toContain("✓ monitor resumed:");

  const removed = await $`bun run src/index.ts monitors rm ${id}`.env(env()).quiet();
  expect(removed.stdout.toString()).toContain("✓ monitor removed:");
});

test("monitors create → update → get reflects changes", async () => {
  const created = await $`bun run src/index.ts monitors create --name original --url https://example.com`
    .env(env()).quiet();
  expect(created.stdout.toString()).toContain("✓ monitor created:");
  const id = created.stdout.toString().trim().split(": ")[1]!;

  const updated = await $`bun run src/index.ts monitors update ${id} --name updated-name --interval 30`
    .env(env()).quiet();
  expect(updated.stdout.toString()).toContain("✓ monitor updated:");

  const got = await $`bun run src/index.ts monitors get ${id}`.env(env()).quiet();
  expect(got.stdout.toString()).toContain("updated-name");
});
