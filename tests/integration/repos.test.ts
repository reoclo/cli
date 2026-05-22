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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-repos-"));
  process.env.REOCLO_CACHE_DIR = join(tmp, "cache");
  seedTenantProfile({ configDir: tmp, apiUrl: gw.url, token: gw.token });
});

afterEach(() => {
  gw.stop();
});

function env(): Record<string, string | undefined> {
  return { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
}

test("repos ls lists all seeded repos", async () => {
  const ls = await $`bun run src/index.ts repos ls`.env(env()).quiet();
  const out = ls.stdout.toString();
  expect(out).toContain("acme/web");
  expect(out).toContain("acme/api");
});

test("repos get resolves slug to id and prints the row", async () => {
  const got = await $`bun run src/index.ts repos get acme/web`.env(env()).quiet();
  const out = got.stdout.toString();
  expect(out).toContain("acme/web");
  expect(out).toContain("main");
});

test("repos branches shows default-branch marker", async () => {
  const br = await $`bun run src/index.ts repos branches acme/web`.env(env()).quiet();
  const out = br.stdout.toString();
  expect(out).toContain("main");
  expect(out).toContain("✓");
});

test("repos get for unknown slug exits 5", async () => {
  const got = await $`bun run src/index.ts repos get acme/nope`.env(env()).nothrow().quiet();
  expect(got.exitCode).toBe(5);
});
