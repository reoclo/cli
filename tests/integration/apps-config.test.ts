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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-cfg-"));
  process.env.REOCLO_CACHE_DIR = join(tmp, "cache");
  seedTenantProfile({ configDir: tmp, apiUrl: gw.url, token: gw.token });
});

afterEach(() => {
  gw.stop();
});

function env(): Record<string, string | undefined> {
  return { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
}

const APP_ID = "11111111-aaaa-aaaa-aaaa-111111111111";

test("apps config get returns seeded config", async () => {
  const r = await $`bun run src/index.ts apps config get ${APP_ID}`.env(env()).quiet();
  const out = r.stdout.toString();
  expect(out).toContain("buildpack");
  expect(out).toContain("node");
});

test("apps config set --replicas 3 --env DEBUG=1 patches config", async () => {
  const r = await $`bun run src/index.ts apps config set ${APP_ID} --replicas 3 --env DEBUG=1`.env(env()).quiet();
  expect(r.stdout.toString()).toContain("✓ config updated");
});

test("apps config set --set deploy.foo=bar exercises dot-path", async () => {
  const r = await $`bun run src/index.ts apps config set ${APP_ID} --set deploy.foo=bar`.env(env()).quiet();
  expect(r.stdout.toString()).toContain("✓ config updated");
  const g = await $`bun run src/index.ts -o json apps config get ${APP_ID}`.env(env()).quiet();
  const cfg = JSON.parse(g.stdout.toString()) as { deploy: Record<string, unknown> };
  expect(cfg.deploy["foo"]).toBe("bar");
});

test("typed flag wins over --set on the same path", async () => {
  const r = await $`bun run src/index.ts apps config set ${APP_ID} --replicas 3 --set deploy.replicas=5`.env(env()).quiet();
  expect(r.stdout.toString()).toContain("✓ config updated");
  const g = await $`bun run src/index.ts -o json apps config get ${APP_ID}`.env(env()).quiet();
  const cfg = JSON.parse(g.stdout.toString()) as { deploy: Record<string, unknown> };
  expect(cfg.deploy["replicas"]).toBe(3);
});

test("empty patch exits 4 with documented message", async () => {
  const r = await $`bun run src/index.ts apps config set ${APP_ID}`.env(env()).nothrow().quiet();
  expect(r.exitCode).toBe(4);
  expect(r.stderr.toString()).toContain("no fields to update");
});

test("apps config get -o yaml dumps yaml", async () => {
  const r = await $`bun run src/index.ts -o yaml apps config get ${APP_ID}`.env(env()).quiet();
  expect(r.stdout.toString()).toContain("buildpack: node");
});

const POOL_PLACEMENT = "pool:44444444-4444-4444-4444-444444444444";
const PUSH_CREDENTIAL = "33333333-3333-3333-3333-333333333333";

test("apps config set --build-placement pool with a push target stores both", async () => {
  const r = await $`bun run src/index.ts apps config set ${APP_ID} --build-placement ${POOL_PLACEMENT} --push-credential ${PUSH_CREDENTIAL} --push-repository ghcr.io/acme/web`
    .env(env()).quiet();
  expect(r.stdout.toString()).toContain("✓ config updated");
  const g = await $`bun run src/index.ts -o json apps config get ${APP_ID}`.env(env()).quiet();
  const cfg = JSON.parse(g.stdout.toString()) as { build: Record<string, unknown> };
  expect(cfg.build["placement"]).toBe(POOL_PLACEMENT);
  expect(cfg.build["push_target"]).toEqual({
    registry_credential_id: PUSH_CREDENTIAL,
    repository: "ghcr.io/acme/web",
  });
  expect(cfg.build["buildpack"]).toBe("node");
});

test("apps config set --build-placement pool without a push target exits 2", async () => {
  const r = await $`bun run src/index.ts apps config set ${APP_ID} --build-placement ${POOL_PLACEMENT}`
    .env(env()).nothrow().quiet();
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("--push-credential");
});

test("apps config set --build-placement with a malformed value exits 2", async () => {
  const r = await $`bun run src/index.ts apps config set ${APP_ID} --build-placement pool:nope`
    .env(env()).nothrow().quiet();
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("target or pool:<pool-id>");
});

test("apps config set --build-placement target needs no push target", async () => {
  const r = await $`bun run src/index.ts apps config set ${APP_ID} --build-placement target`.env(env()).quiet();
  expect(r.stdout.toString()).toContain("✓ config updated");
});
