import { afterEach, beforeEach, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startFakeGateway, type FakeGateway } from "../helpers/fake-gateway";
import { seedTenantProfile } from "../helpers/seed-profile";

let tmp: string;
let gw: FakeGateway;

beforeEach(() => {
  gw = startFakeGateway();
  tmp = mkdtempSync(join(tmpdir(), "reoclo-deploy-"));
});

afterEach(() => {
  gw.stop();
});

/** Env for the automation-key (rca_*) path — no profile needed. */
function autoEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    REOCLO_CONFIG_DIR: tmp,
    REOCLO_CACHE_DIR: join(tmp, "cache"),
    REOCLO_AUTOMATION_KEY: gw.automationKey,
    REOCLO_API_URL: gw.url,
  };
}

test("deploy sync --services: two-token flow syncs and self-revokes (text output)", async () => {
  const r = await $`bun run src/index.ts deploy sync --services api:3000`
    .env(autoEnv())
    .nothrow()
    .quiet();
  expect(r.exitCode).toBe(0);
  const out = r.stdout.toString();
  expect(out).toContain("api: synced");
  expect(out).toContain("api.example.com");
  // Session was revoked in the finally block.
  expect(gw.deployRevokes).toContain("sess-int-1");
});

test("deploy sync -o json emits {session_id, synced_fqdns, results, errors}", async () => {
  const r = await $`bun run src/index.ts -o json deploy sync --services api:3000`
    .env(autoEnv())
    .nothrow()
    .quiet();
  expect(r.exitCode).toBe(0);
  const body = JSON.parse(r.stdout.toString()) as {
    session_id: string;
    synced_fqdns: string[];
    results: unknown[];
    errors: unknown[];
  };
  expect(body.session_id).toBe("sess-int-1");
  expect(body.synced_fqdns).toContain("api.example.com");
  expect(body.results).toHaveLength(1);
  expect(body.errors).toEqual([]);
});

test("deploy sync --compose-file discovers reoclo-managed services", async () => {
  const composePath = join(tmp, "docker-compose.yml");
  writeFileSync(
    composePath,
    `
services:
  web:
    container_name: web-prod
    image: acme/web:latest
    networks: [reoclo-proxy]
    ports: ["8080:3000"]
  db:
    image: postgres
    ports: ["5432:5432"]
`,
  );
  const r = await $`bun run src/index.ts deploy sync --compose-file ${composePath}`
    .env(autoEnv())
    .nothrow()
    .quiet();
  expect(r.exitCode).toBe(0);
  const out = r.stdout.toString();
  expect(out).toContain("web-prod: synced");
  // The unmanaged `db` service must not be synced.
  expect(out).not.toContain("db:");
});

test("conflict without --force exits non-zero and still revokes", async () => {
  const r = await $`bun run src/index.ts deploy sync --services conflict-svc:3000`
    .env(autoEnv())
    .nothrow()
    .quiet();
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString()).toContain("conflict");
  expect(gw.deployRevokes).toContain("sess-int-1");
});

test("conflict WITH --force exits 0", async () => {
  const r = await $`bun run src/index.ts deploy sync --services conflict-svc:3000 --force`
    .env(autoEnv())
    .nothrow()
    .quiet();
  expect(r.exitCode).toBe(0);
});

test("--compose-file and --services together exit 2 (mutually exclusive)", async () => {
  const r = await $`bun run src/index.ts deploy sync --services api:3000 --compose-file x.yml`
    .env(autoEnv())
    .nothrow()
    .quiet();
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("mutually exclusive");
});

test("neither --compose-file nor --services exits 2", async () => {
  const r = await $`bun run src/index.ts deploy sync`.env(autoEnv()).nothrow().quiet();
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("provide either");
});

test("a tenant (non-automation) key is rejected with exit 4", async () => {
  seedTenantProfile({ configDir: tmp, apiUrl: gw.url, token: gw.token });
  const env = {
    ...process.env,
    REOCLO_CONFIG_DIR: tmp,
    REOCLO_CACHE_DIR: join(tmp, "cache"),
  };
  const r = await $`bun run src/index.ts deploy sync --services api:3000`
    .env(env)
    .nothrow()
    .quiet();
  expect(r.exitCode).toBe(4);
  expect(r.stderr.toString()).toContain("automation key");
});
