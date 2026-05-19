// tests/integration/incidents.test.ts
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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-inc-"));
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

test("incidents create → ls → add-update → get (inline updates) → resolve", async () => {
  const created = await $`bun run src/index.ts incidents create --title "DB outage" --severity major`
    .env(env()).quiet();
  expect(created.stdout.toString()).toContain("✓ incident created:");
  const id = created.stdout.toString().trim().split(": ")[1]!;

  const ls = await $`bun run src/index.ts incidents ls`.env(env()).quiet();
  expect(ls.stdout.toString()).toContain("DB outage");

  const posted = await $`bun run src/index.ts incidents add-update ${id} --message "investigating" --state identified`
    .env(env()).quiet();
  expect(posted.stdout.toString()).toContain("✓ update posted");

  const got = await $`bun run src/index.ts incidents get ${id}`.env(env()).quiet();
  expect(got.stdout.toString()).toContain("updates (1):");
  expect(got.stdout.toString()).toContain("investigating");

  const resolved = await $`bun run src/index.ts incidents update ${id} --state resolved`
    .env(env()).quiet();
  expect(resolved.stdout.toString()).toContain("✓ incident updated:");
});
