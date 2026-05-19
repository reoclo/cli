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

test("containers recreate / scale / labels", async () => {
  const rc = await $`bun run src/index.ts containers recreate srv-1 web-1 --env PORT=8080 --label tier=web`
    .env(env()).quiet();
  expect(rc.stdout.toString()).toContain("✓ container recreated: web-1");

  const sc = await $`bun run src/index.ts containers scale srv-1 web-1 3`.env(env()).quiet();
  expect(sc.stdout.toString()).toContain("✓ scaled web-1 to 3");

  const lb = await $`bun run src/index.ts containers labels srv-1 web-1 --label env=prod --remove-label old`
    .env(env()).quiet();
  expect(lb.stdout.toString()).toContain("✓ labels updated: web-1");
});

test("containers inspect / logs / restart", async () => {
  const ins = await $`bun run src/index.ts containers inspect srv-1 web-1 -o json`
    .env(env()).quiet();
  const inspected = JSON.parse(ins.stdout.toString()) as { container_name: string };
  expect(inspected.container_name).toBe("web-1");

  const lg = await $`bun run src/index.ts containers logs srv-1 web-1`.env(env()).quiet();
  expect(lg.stdout.toString()).toContain("log line 1");

  const rs = await $`bun run src/index.ts containers restart srv-1 web-1`.env(env()).quiet();
  expect(rs.stdout.toString()).toContain("✓ container restarted: web-1");
});
