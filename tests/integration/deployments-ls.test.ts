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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-dls-"));
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

test("deployments ls --limit abc exits non-zero with validation message", async () => {
  const r = await $`bun run src/index.ts deployments ls --limit abc`.env(env()).nothrow().quiet();
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString()).toContain("invalid --limit");
  expect(r.stderr.toString()).toContain("abc");
});

test("deployments ls --skip -1 exits non-zero with validation message", async () => {
  const r = await $`bun run src/index.ts deployments ls --skip -1`.env(env()).nothrow().quiet();
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString()).toContain("invalid --skip");
});

test("deployments ls --skip 0 is accepted", async () => {
  const r = await $`bun run src/index.ts deployments ls --skip 0 --limit 5`.env(env()).nothrow().quiet();
  // Either the fake gateway answers or returns a non-validation error;
  // the key assertion is that the CLI does not reject the input itself.
  expect(r.stderr.toString()).not.toContain("invalid --skip");
  expect(r.stderr.toString()).not.toContain("invalid --limit");
});
