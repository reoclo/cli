// tests/integration/status-pages.test.ts
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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-sp-"));
  process.env.REOCLO_CACHE_DIR = join(tmp, "cache");
  seedTenantProfile({ configDir: tmp, apiUrl: gw.url, token: gw.token });
});

afterEach(() => {
  gw.stop();
});

function env(): Record<string, string | undefined> {
  return { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
}

test("status-pages create → ls → update → rm", async () => {
  const created = await $`bun run src/index.ts status-pages create --title "Public Status"`
    .env(env()).quiet();
  expect(created.stdout.toString()).toContain("✓ status page created:");
  const id = created.stdout.toString().trim().split(": ")[1]!;

  const ls = await $`bun run src/index.ts status-pages ls`.env(env()).quiet();
  expect(ls.stdout.toString()).toContain("Public Status");

  const updated = await $`bun run src/index.ts status-pages update ${id} --published true`
    .env(env()).quiet();
  expect(updated.stdout.toString()).toContain("✓ status page updated:");

  const got = await $`bun run src/index.ts status-pages get ${id} --output json`
    .env(env()).quiet();
  expect(got.stdout.toString()).toContain("true");

  const removed = await $`bun run src/index.ts status-pages rm ${id}`.env(env()).quiet();
  expect(removed.stdout.toString()).toContain("✓ status page removed:");
});
