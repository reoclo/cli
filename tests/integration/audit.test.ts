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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-audit-"));
  process.env.REOCLO_CACHE_DIR = join(tmp, "cache");
  seedTenantProfile({ configDir: tmp, apiUrl: gw.url, token: gw.token });
});

afterEach(() => {
  gw.stop();
});

function env(): Record<string, string | undefined> {
  return { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
}

test("audit ls default lists 50 most recent", async () => {
  const ls = await $`bun run src/index.ts audit ls`.env(env()).quiet();
  const lines = ls.stdout.toString().trim().split("\n");
  expect(lines.length).toBe(51); // 1 header + 50 rows
});

test("audit ls --actor by email resolves and filters", async () => {
  const ls = await $`bun run src/index.ts audit ls --actor a@x.com`.env(env()).quiet();
  const out = ls.stdout.toString();
  expect(out).toContain("a@x.com");
  expect(out).not.toContain("b@x.com");
});

test("audit ls --actor by id passes through", async () => {
  const ls = await $`bun run src/index.ts audit ls --actor user-2`.env(env()).quiet();
  const out = ls.stdout.toString();
  expect(out).toContain("b@x.com");
});

test("audit ls --actor unknown@x.com yields zero rows, no crash", async () => {
  const ls = await $`bun run src/index.ts audit ls --actor unknown@x.com`.env(env()).quiet();
  const lines = ls.stdout.toString().trim().split("\n");
  expect(lines.length).toBeLessThanOrEqual(1);
});

test("audit ls --action deploy_succeeded filters", async () => {
  const ls = await $`bun run src/index.ts audit ls --action deploy_succeeded`.env(env()).quiet();
  const out = ls.stdout.toString();
  expect(out).toContain("deploy_succeeded");
  const lines = out.trim().split("\n").slice(1);
  for (const line of lines) expect(line).toContain("deploy_succeeded");
});

test("audit ls --limit 250 auto-paginates", async () => {
  const ls = await $`bun run src/index.ts audit ls --limit 250`.env(env()).quiet();
  const lines = ls.stdout.toString().trim().split("\n");
  expect(lines.length).toBe(251); // 1 header + 250 rows
});

test("audit ls --from 24h produces output", async () => {
  const ls = await $`bun run src/index.ts audit ls --from 24h --limit 1000`.env(env()).quiet();
  expect(ls.stdout.toString().length).toBeGreaterThan(0);
});

test("audit ls --from invalid spec exits with documented message", async () => {
  const ls = await $`bun run src/index.ts audit ls --from abc`.env(env()).nothrow().quiet();
  expect(ls.exitCode).not.toBe(0);
  expect(ls.stderr.toString()).toContain("invalid time spec");
});

test("audit ls --limit abc exits non-zero with the validation message", async () => {
  const r = await $`bun run src/index.ts audit ls --limit abc`.env(env()).nothrow().quiet();
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString()).toContain("invalid --limit");
  expect(r.stderr.toString()).toContain("abc");
});

test("audit ls --limit 1.5 exits 2 with the documented message", async () => {
  const r = await $`bun run src/index.ts audit ls --limit 1.5`.env(env()).nothrow().quiet();
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("invalid --limit");
  expect(r.stderr.toString()).toContain("1.5");
});
