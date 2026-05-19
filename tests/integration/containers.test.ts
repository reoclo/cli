// tests/integration/containers.test.ts
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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-ctr-"));
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

test("containers ls auto-paginates the fleet", async () => {
  const ls = await $`bun run src/index.ts containers ls`.env(env()).quiet();
  expect(ls.stdout.toString()).toContain("web-1");
  expect(ls.stdout.toString()).toContain("worker-1");
});

test("containers ls --status filters", async () => {
  const ls = await $`bun run src/index.ts containers ls --status running`.env(env()).quiet();
  expect(ls.stdout.toString()).toContain("web-1");
  expect(ls.stdout.toString()).not.toContain("worker-1");
});

test("containers refresh", async () => {
  const r = await $`bun run src/index.ts containers refresh`.env(env()).quiet();
  expect(r.stdout.toString()).toContain("✓ snapshot refresh triggered");
});
