// tests/integration/server-ops.test.ts
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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-srvops-"));
  process.env.REOCLO_CACHE_DIR = join(tmp, "cache");
  seedTenantProfile({ configDir: tmp, apiUrl: gw.url, token: gw.token });
});

afterEach(() => {
  gw.stop();
});

function env(): Record<string, string | undefined> {
  return { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
}

test("servers containers / health / ports / uptime", async () => {
  const ctr = await $`bun run src/index.ts servers containers srv-1`.env(env()).quiet();
  expect(ctr.stdout.toString()).toContain("web-1");

  const hl = await $`bun run src/index.ts servers health srv-1`.env(env()).quiet();
  expect(hl.stdout.toString()).toContain("healthy");

  const pt = await $`bun run src/index.ts servers ports srv-1`.env(env()).quiet();
  expect(pt.stdout.toString()).toContain("sshd");
  expect(pt.stdout.toString()).toContain("firewall:");

  const up = await $`bun run src/index.ts servers uptime srv-1`.env(env()).quiet();
  expect(up.stdout.toString()).toContain("overall uptime: 100%");
});

test("servers reboot --yes skips the prompt", async () => {
  const rb = await $`bun run src/index.ts servers reboot srv-1 --yes`.env(env()).quiet();
  expect(rb.stdout.toString()).toContain("✓ reboot signaled: srv-1");
});

test("servers reboot without --yes aborts non-interactively", async () => {
  const rb = await $`bun run src/index.ts servers reboot srv-1`.env(env()).nothrow().quiet();
  expect(rb.exitCode).not.toBe(0);
  expect(rb.stderr.toString()).toContain("--yes");
});
