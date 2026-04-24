// tests/integration/read-commands.test.ts
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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-read-"));
  // Override cache dir as well so the slug cache from a prior run doesn't
  // pollute this test (resolve.ts writes to cacheDir()/slug-cache.json).
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

test("servers ls returns srv-1 (text format)", async () => {
  const env = { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
  const r = await $`bun run src/index.ts servers ls`.env(env).quiet();
  expect(r.stdout.toString()).toContain("srv-1");
  expect(r.stdout.toString()).toContain("1.1.1.1");
});

test("servers ls returns srv-1 (json format)", async () => {
  const env = { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
  const r = await $`bun run src/index.ts -o json servers ls`.env(env).quiet();
  // ndjson: one JSON object per line
  const line = r.stdout.toString().trim().split("\n")[0]!;
  const parsed: { name: string } = JSON.parse(line) as { name: string };
  expect(parsed.name).toBe("srv-1");
});

test("apps ls returns app-1", async () => {
  const env = { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
  const r = await $`bun run src/index.ts apps ls`.env(env).quiet();
  expect(r.stdout.toString()).toContain("app-1");
});

test("servers get by name resolves slug → id", async () => {
  const env = { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
  const r = await $`bun run src/index.ts servers get srv-1`.env(env).quiet();
  expect(r.stdout.toString()).toContain("00000000-0000-0000-0000-00000000bbbb");
});

test("apps get by slug resolves slug → id", async () => {
  const env = { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
  const r = await $`bun run src/index.ts apps get app-1`.env(env).quiet();
  expect(r.stdout.toString()).toContain("00000000-0000-0000-0000-00000000cccc");
});
