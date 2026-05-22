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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-dstage-"));
  process.env.REOCLO_CACHE_DIR = join(tmp, "cache");
  seedTenantProfile({ configDir: tmp, apiUrl: gw.url, token: gw.token });
});

afterEach(() => {
  gw.stop();
});

function env(): Record<string, string | undefined> {
  return { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
}

test("deployments stages shows build/push/deploy rows", async () => {
  const r = await $`bun run src/index.ts deployments stages dep-1`.env(env()).quiet();
  const out = r.stdout.toString();
  expect(out).toContain("build");
  expect(out).toContain("push");
  expect(out).toContain("deploy");
  expect(out).toContain("succeeded");
});

test("deployments stages shows duration formatted", async () => {
  const r = await $`bun run src/index.ts deployments stages dep-1`.env(env()).quiet();
  // build stage = 1m30s
  expect(r.stdout.toString()).toMatch(/1m30s/);
});

test("deployments stages -o json round-trips", async () => {
  const r = await $`bun run src/index.ts -o json deployments stages dep-1`.env(env()).quiet();
  const lines = r.stdout.toString().trim().split("\n").filter((l) => l.trim().length > 0);
  expect(lines.length).toBeGreaterThan(0);
});
