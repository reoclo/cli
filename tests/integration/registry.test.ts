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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-reg-"));
  process.env.REOCLO_CACHE_DIR = join(tmp, "cache");
  seedTenantProfile({ configDir: tmp, apiUrl: gw.url, token: gw.token });
});

afterEach(() => {
  gw.stop();
});

function env(): Record<string, string | undefined> {
  return { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
}

test("registry ls lists seeded credentials", async () => {
  const ls = await $`bun run src/index.ts registry ls`.env(env()).quiet();
  expect(ls.stdout.toString()).toContain("dockerhub-main");
});

test("registry get shows credential (password masked)", async () => {
  const got = await $`bun run src/index.ts registry get 33333333-3333-3333-3333-333333333333`
    .env(env()).quiet();
  const out = got.stdout.toString();
  expect(out).toContain("dockerhub-main");
  expect(out).toContain("MASKED");
});

test("registry rm --yes deletes the credential", async () => {
  const rm = await $`bun run src/index.ts registry rm 33333333-3333-3333-3333-333333333333 --yes`
    .env(env()).quiet();
  expect(rm.stdout.toString()).toContain("✓ registry removed");
});

test("registry rm without --yes in non-TTY exits non-zero", async () => {
  const rm = await $`bun run src/index.ts registry rm 33333333-3333-3333-3333-333333333333`
    .env(env()).nothrow().quiet();
  expect(rm.exitCode).not.toBe(0);
});

test("registry create --password-stdin posts secret and returns new id", async () => {
  const created = await $`echo -n "s3cret" | bun run src/index.ts registry create \
    --name ecr-prod --type ecr --url 'https://1234.dkr.ecr.us-east-1.amazonaws.com' \
    --username AWS --password-stdin`.env(env()).quiet();
  expect(created.stdout.toString()).toContain("✓ registry created:");
});

test("registry create without --password-stdin in non-TTY exits 5", async () => {
  const r = await $`bun run src/index.ts registry create --name x --type docker --url https://x.io`
    .env(env()).nothrow().quiet();
  expect(r.exitCode).toBe(5);
});

test("registry create with --password-stdin and empty stdin exits 5", async () => {
  const r = await $`echo -n "" | bun run src/index.ts registry create \
    --name x --type docker --url https://x.io --password-stdin`.env(env()).nothrow().quiet();
  expect(r.exitCode).toBe(5);
});

test("registry update rotates password", async () => {
  const r = await $`echo -n "new-pw" | bun run src/index.ts registry update \
    33333333-3333-3333-3333-333333333333 --password-stdin`.env(env()).quiet();
  expect(r.stdout.toString()).toContain("✓ registry updated:");
});

test("registry test (success) prints ✓ ok and latency", async () => {
  const r = await $`echo -n "pw" | bun run src/index.ts registry test \
    --type docker --url 'https://index.docker.io/v1/' --username acme --password-stdin`
    .env(env()).quiet();
  expect(r.stdout.toString()).toContain("✓ ok");
  expect(r.stdout.toString()).toContain("42");
});

test("registry test (failure) prints ✗ message and exits non-zero", async () => {
  const r = await $`echo -n "pw" | bun run src/index.ts registry test \
    --type docker --url 'https://bad.example.com' --username acme --password-stdin`
    .env(env()).nothrow().quiet();
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString() + r.stdout.toString()).toContain("DNS lookup failed");
});

test("registry test without --username still succeeds (no empty-string username sent)", async () => {
  const r = await $`echo -n "pw" | bun run src/index.ts registry test \
    --type docker --url 'https://index.docker.io/v1/' --password-stdin`
    .env(env())
    .quiet();
  expect(r.stdout.toString()).toContain("✓ ok");
});

test("registry create --type bogus exits non-zero with enum message", async () => {
  const r = await $`echo -n "pw" | bun run src/index.ts registry create --name x --type bogus --url https://x.io --password-stdin`
    .env(env()).nothrow().quiet();
  expect(r.exitCode).not.toBe(0);
  const errOut = r.stderr.toString() + r.stdout.toString();
  expect(errOut).toMatch(/Invalid|expected|enum|docker|ecr|private/);
});

test("registry test --type bogus exits non-zero", async () => {
  const r = await $`echo -n "pw" | bun run src/index.ts registry test --type bogus --url https://x.io --password-stdin`
    .env(env()).nothrow().quiet();
  expect(r.exitCode).not.toBe(0);
});
