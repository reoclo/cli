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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-reg-"));
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
