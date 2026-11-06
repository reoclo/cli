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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-findings-"));
  process.env.REOCLO_CACHE_DIR = join(tmp, "cache");
  seedTenantProfile({ configDir: tmp, apiUrl: gw.url, token: gw.token });
});

afterEach(() => {
  gw.stop();
});

function env(): Record<string, string | undefined> {
  return { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
}

const OPEN_ID = "f1111111-0000-0000-0000-000000000001";

test("findings list shows only open findings by default", async () => {
  const r = await $`bun run src/index.ts -o json findings list`.env(env()).quiet();
  const rows = r.stdout.toString().trim().split("\n").map((l) => JSON.parse(l) as { id: string });
  expect(rows.map((row) => row.id)).toEqual([OPEN_ID]);
  expect(gw.findingRequests).toEqual(["?status=open"]);
});

test("findings list --state all sends no status filter", async () => {
  const r = await $`bun run src/index.ts -o json findings list --state all --severity high`
    .env(env())
    .quiet();
  expect(r.stdout.toString().trim().split("\n")).toHaveLength(2);
  expect(gw.findingRequests).toEqual(["?severity=high"]);
});

test("findings list prints a table in text mode", async () => {
  const r = await $`bun run src/index.ts -o text findings list`.env(env()).quiet();
  const out = r.stdout.toString();
  expect(out).toContain("SEVERITY");
  expect(out).toContain("finding 1");
  expect(out).not.toContain("finding 2");
});

test("findings get shows the finding and its evidence", async () => {
  const r = await $`bun run src/index.ts -o text findings get ${OPEN_ID}`.env(env()).quiet();
  const out = r.stdout.toString();
  expect(out).toContain("a summary");
  expect(out).toContain("EVIDENCE");
  expect(out).toContain("boom");
});

test("findings get exits 5 with the watcher hint for an unknown id", async () => {
  const r = await $`bun run src/index.ts findings get f1111111-0000-0000-0000-0000000000ff`
    .env(env())
    .nothrow()
    .quiet();
  expect(r.exitCode).toBe(5);
  expect(r.stderr.toString()).toContain("log watcher is not enabled");
});

test("findings resolve moves the finding to resolved", async () => {
  const r = await $`bun run src/index.ts findings resolve ${OPEN_ID}`.env(env()).quiet();
  expect(r.stdout.toString()).toContain("✓ finding resolved");
  const open = await $`bun run src/index.ts -o json findings list`.env(env()).quiet();
  expect(open.stdout.toString().trim()).toBe("");
});

test("alerts list points at open findings on stderr", async () => {
  const r = await $`bun run src/index.ts -o text alerts list`.env(env()).nothrow().quiet();
  expect(r.stderr.toString()).toContain("1 open log watcher finding: run 'reoclo findings list'");
});
