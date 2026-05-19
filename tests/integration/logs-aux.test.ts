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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-laux-"));
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

test("logs system fetches journal logs from a server", async () => {
  const r = await $`bun run src/index.ts logs system srv-1 --unit kernel --tail 50`.env(env()).quiet();
  expect(r.stdout.toString().length).toBeGreaterThan(0);
});

test("logs sources renders containers and journal units", async () => {
  const r = await $`bun run src/index.ts logs sources srv-1`.env(env()).quiet();
  const out = r.stdout.toString();
  expect(out).toContain("Containers");
  expect(out).toContain("app-container");
  expect(out).toContain("Journal units");
  expect(out).toContain("kernel");
});

test("logs sources -o json dumps raw payload", async () => {
  const r = await $`bun run src/index.ts -o json logs sources srv-1`.env(env()).quiet();
  const obj = JSON.parse(r.stdout.toString()) as Record<string, unknown>;
  expect(Array.isArray(obj["containers"])).toBe(true);
  expect(Array.isArray(obj["journal_units"])).toBe(true);
});

test("logs stats prints by_level + by_source + total", async () => {
  const r = await $`bun run src/index.ts logs stats`.env(env()).quiet();
  const out = r.stdout.toString();
  expect(out).toContain("info");
  expect(out).toContain("error");
  expect(out).toContain("1171");
});

test("logs usage prints storage_bytes and retention_days", async () => {
  const r = await $`bun run src/index.ts logs usage`.env(env()).quiet();
  const out = r.stdout.toString();
  expect(out).toContain("storage_bytes");
  expect(out).toContain("retention_days");
});

test("logs usage -o json round-trips", async () => {
  const r = await $`bun run src/index.ts -o json logs usage`.env(env()).quiet();
  const obj = JSON.parse(r.stdout.toString()) as Record<string, number>;
  expect(typeof obj["storage_bytes"]).toBe("number");
});
