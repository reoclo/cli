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

test("registry get shows the credential record without any secret field", async () => {
  const got = await $`bun run src/index.ts -o json registry get 33333333-3333-3333-3333-333333333333`
    .env(env()).quiet();
  const row = JSON.parse(got.stdout.toString()) as Record<string, unknown>;
  expect(row["name"]).toBe("dockerhub-main");
  expect(Object.keys(row).filter((k) => k.includes("credential"))).toEqual([]);
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

test("registry create --push --repository-prefix sends the push capability and prefix", async () => {
  const created = await $`echo -n "s3cret" | bun run src/index.ts -o json registry create \
    --name ghcr-push --type private --url https://ghcr.io --username bot \
    --push --repository-prefix ghcr.io/acme/ --password-stdin`.env(env()).quiet();
  const row = JSON.parse(created.stdout.toString()) as Record<string, unknown>;
  expect(row["capabilities"]).toEqual(["pull", "push"]);
  expect(row["repository_prefix"]).toBe("ghcr.io/acme/");
});

test("registry create without --push leaves the default pull-only capability", async () => {
  const created = await $`echo -n "s3cret" | bun run src/index.ts -o json registry create \
    --name ghcr-pull --type private --url https://ghcr.io --password-stdin`.env(env()).quiet();
  const row = JSON.parse(created.stdout.toString()) as Record<string, unknown>;
  expect(row["capabilities"]).toEqual(["pull"]);
});

test("registry create sends the secret as credential and never reads it back", async () => {
  const created = await $`echo -n "s3cret" | bun run src/index.ts -o json registry create \
    --name ghcr-main --type private --url https://ghcr.io --username bot --password-stdin`.env(env()).quiet();
  expect(gw.registryBodies).toHaveLength(1);
  expect(gw.registryBodies[0]).toMatchObject({ credential: "s3cret" });
  expect(gw.registryBodies[0]).not.toHaveProperty("encrypted_credential");
  expect(created.stdout.toString()).not.toContain("s3cret");
});

test("registry update rotates the secret as credential and never reads it back", async () => {
  const updated = await $`echo -n "rotated" | bun run src/index.ts -o json registry update \
    33333333-3333-3333-3333-333333333333 --password-stdin`.env(env()).quiet();
  expect(gw.registryBodies).toEqual([{ credential: "rotated" }]);
  expect(updated.stdout.toString()).not.toContain("rotated");
});

test("registry test sends the secret as credential", async () => {
  await $`echo -n "pw" | bun run src/index.ts registry test \
    --type docker --url 'https://index.docker.io/v1/' --username acme --password-stdin`.env(env()).quiet();
  expect(gw.registryBodies).toHaveLength(1);
  expect(gw.registryBodies[0]).toMatchObject({ credential: "pw" });
  expect(gw.registryBodies[0]).not.toHaveProperty("encrypted_credential");
});
