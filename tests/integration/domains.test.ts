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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-dom-"));
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

test("domains dns shows records table and overall status", async () => {
  const r = await $`bun run src/index.ts domains dns example.com`.env(env()).quiet();
  const out = r.stdout.toString();
  expect(out).toContain("1.2.3.4");
  expect(out).toContain("AAAA");
  expect(out).toContain("missing");
  expect(out).toContain("mismatch");
});

test("domains health prints composite", async () => {
  const r = await $`bun run src/index.ts domains health example.com`.env(env()).quiet();
  const out = r.stdout.toString();
  expect(out).toContain("dns");
  expect(out).toContain("tls");
  expect(out).toContain("uptime");
});

test("domains rm --yes deletes", async () => {
  const r = await $`bun run src/index.ts domains rm example.com --yes`.env(env()).quiet();
  expect(r.stdout.toString()).toContain("✓ domain removed");
});

test("domains rm without --yes in non-TTY exits non-zero", async () => {
  const r = await $`bun run src/index.ts domains rm example.com`.env(env()).nothrow().quiet();
  expect(r.exitCode).not.toBe(0);
});
