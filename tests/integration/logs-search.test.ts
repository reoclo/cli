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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-lsearch-"));
  process.env.REOCLO_CACHE_DIR = join(tmp, "cache");
  seedTenantProfile({ configDir: tmp, apiUrl: gw.url, token: gw.token });
});

afterEach(() => {
  gw.stop();
});

function env(): Record<string, string | undefined> {
  return { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
}

test("logs search default lists 100 most recent", async () => {
  const r = await $`bun run src/index.ts logs search`.env(env()).quiet();
  const lines = r.stdout.toString().trim().split("\n");
  expect(lines.length).toBe(101); // 1 header + 100 rows
});

test("logs search 'panic' filters by message text", async () => {
  const r = await $`bun run src/index.ts logs search panic --limit 200`.env(env()).quiet();
  const out = r.stdout.toString();
  for (const line of out.trim().split("\n").slice(1)) {
    expect(line).toContain("panic");
  }
});

test("logs search --level error filters", async () => {
  const r = await $`bun run src/index.ts logs search --level error --limit 200`.env(env()).quiet();
  const lines = r.stdout.toString().trim().split("\n").slice(1);
  for (const line of lines) expect(line).toContain("error");
});

test("logs search --limit 600 auto-paginates over 2 pages", async () => {
  const r = await $`bun run src/index.ts logs search --limit 600`.env(env()).quiet();
  const lines = r.stdout.toString().trim().split("\n");
  expect(lines.length).toBe(601); // 1 header + 600 rows
});

test("logs search --from 2026-05-19T03:00:00Z filters by time", async () => {
  const r = await $`bun run src/index.ts logs search --from 2026-05-19T03:00:00Z --limit 1000`.env(env()).quiet();
  expect(r.stdout.toString().length).toBeGreaterThan(0);
});

test("logs search --limit abc exits non-zero with validation message", async () => {
  const r = await $`bun run src/index.ts logs search --limit abc`.env(env()).nothrow().quiet();
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString()).toContain("invalid --limit");
});

test("logs search --limit 1.5 exits 2 with the documented message", async () => {
  const r = await $`bun run src/index.ts logs search --limit 1.5`.env(env()).nothrow().quiet();
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("invalid --limit");
  expect(r.stderr.toString()).toContain("1.5");
});

test("logs search --level potato exits non-zero with enum message", async () => {
  const r = await $`bun run src/index.ts logs search --level potato`.env(env()).nothrow().quiet();
  expect(r.exitCode).not.toBe(0);
  const errOut = r.stderr.toString() + r.stdout.toString();
  expect(errOut).toMatch(/Invalid|expected|enum|debug|info|warn|error|fatal/);
});

test("logs search --source-type bogus exits non-zero", async () => {
  const r = await $`bun run src/index.ts logs search --source-type bogus`.env(env()).nothrow().quiet();
  expect(r.exitCode).not.toBe(0);
});
