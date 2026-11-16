// tests/integration/status-pages.test.ts
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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-sp-"));
  process.env.REOCLO_CACHE_DIR = join(tmp, "cache");
  seedTenantProfile({ configDir: tmp, apiUrl: gw.url, token: gw.token });
});

afterEach(() => {
  gw.stop();
});

function env(): Record<string, string | undefined> {
  return { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
}

async function themeOf(id: string): Promise<{ theme: string; branding: unknown }> {
  const got = await $`bun run src/index.ts status-pages get ${id} --output json`.env(env()).quiet();
  return JSON.parse(got.stdout.toString()) as { theme: string; branding: unknown };
}

test("status-pages create and update send branding.theme, and get shows it", async () => {
  const created = await $`bun run src/index.ts status-pages create --title Themed --theme dark`
    .env(env()).quiet();
  const id = /status page created: (\S+) \(slug: /.exec(created.stdout.toString())?.[1];
  if (!id) throw new Error(`no id in create output: ${created.stdout.toString()}`);
  expect(await themeOf(id)).toMatchObject({ theme: "dark", branding: { theme: "dark" } });

  await $`bun run src/index.ts status-pages update ${id} --theme survey_sheet`.env(env()).quiet();
  expect(await themeOf(id)).toMatchObject({ theme: "survey_sheet", branding: { theme: "survey_sheet" } });
});

test("status-pages get reports light for a page with no stored theme", async () => {
  const created = await $`bun run src/index.ts status-pages create --title Plain`.env(env()).quiet();
  const id = /status page created: (\S+) \(slug: /.exec(created.stdout.toString())?.[1];
  if (!id) throw new Error(`no id in create output: ${created.stdout.toString()}`);
  expect((await themeOf(id)).theme).toBe("light");
});

test("status-pages create and update exit 2 on an unknown theme", async () => {
  const bad = await $`bun run src/index.ts status-pages create --title X --theme neon`
    .env(env()).nothrow().quiet();
  expect(bad.exitCode).toBe(2);
  expect(bad.stderr.toString()).toContain("light, dark, system, survey_sheet");
});

test("status-pages create → ls → update → rm", async () => {
  const created = await $`bun run src/index.ts status-pages create --title "Public Status"`
    .env(env()).quiet();
  expect(created.stdout.toString()).toContain("✓ status page created:");
  const id = /status page created: (\S+) \(slug: /.exec(created.stdout.toString())?.[1];
  if (!id) throw new Error(`no id in create output: ${created.stdout.toString()}`);

  const ls = await $`bun run src/index.ts status-pages ls`.env(env()).quiet();
  expect(ls.stdout.toString()).toContain("Public Status");

  const updated = await $`bun run src/index.ts status-pages update ${id} --published true`
    .env(env()).quiet();
  expect(updated.stdout.toString()).toContain("✓ status page updated:");

  const got = await $`bun run src/index.ts status-pages get ${id} --output json`
    .env(env()).quiet();
  expect(got.stdout.toString()).toContain("true");

  const removed = await $`bun run src/index.ts status-pages rm ${id} --yes`.env(env()).quiet();
  expect(removed.stdout.toString()).toContain("✓ status page removed:");
});
