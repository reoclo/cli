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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-cfg-"));
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
