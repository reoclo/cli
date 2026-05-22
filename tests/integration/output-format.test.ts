// tests/integration/output-format.test.ts
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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-fmt-"));
  process.env.REOCLO_CACHE_DIR = join(tmp, "cache");
  seedTenantProfile({ configDir: tmp, apiUrl: gw.url, token: gw.token });
});

afterEach(() => {
  gw.stop();
});

function env(): Record<string, string | undefined> {
  return { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
}

test("-o json on mutation dumps the response object", async () => {
  const r = await $`bun run src/index.ts -o json monitors create --name fmt-test --url https://example.com`
    .env(env())
    .quiet();
  const obj = JSON.parse(r.stdout.toString()) as Record<string, unknown>;
  expect(obj["name"]).toBe("fmt-test");
  expect(r.stdout.toString()).not.toContain("✓ monitor created");
});

test("-o yaml on mutation dumps the response object as yaml", async () => {
  const r = await $`bun run src/index.ts -o yaml monitors create --name fmt-yaml --url https://example.com`
    .env(env())
    .quiet();
  expect(r.stdout.toString()).toContain("name: fmt-yaml");
  expect(r.stdout.toString()).not.toContain("✓ monitor created");
});

test("text mode (default) still prints the ✓ line", async () => {
  const r = await $`bun run src/index.ts monitors create --name fmt-text --url https://example.com`
    .env(env())
    .quiet();
  expect(r.stdout.toString()).toContain("✓ monitor created");
});
