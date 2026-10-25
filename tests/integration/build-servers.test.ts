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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-build-"));
  process.env.REOCLO_CACHE_DIR = join(tmp, "cache");
  seedTenantProfile({ configDir: tmp, apiUrl: gw.url, token: gw.token });
});

afterEach(() => {
  gw.stop();
});

function env(): Record<string, string | undefined> {
  return { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
}

const SERVER_ID = "00000000-0000-0000-0000-00000000bbbb";
const POOL_ID = "44444444-4444-4444-4444-444444444444";
const FAILED_BUILD_ID = "55555555-0000-0000-0000-000000000002";
const QUEUED_BUILD_ID = "55555555-0000-0000-0000-000000000003";

/** `ls` under -o json prints one JSON object per line. */
function rows(stdout: Buffer): Array<Record<string, unknown>> {
  return stdout
    .toString()
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("build-pools ls lists the seeded pool with its builder count", async () => {
  const r = await $`bun run src/index.ts build-pools ls`.env(env()).quiet();
  const out = r.stdout.toString();
  expect(out).toContain("pool-a");
  expect(out).toContain("BUILDERS");
});

test("build-pools get resolves a pool by name", async () => {
  const r = await $`bun run src/index.ts -o json build-pools get pool-a`.env(env()).quiet();
  const pool = JSON.parse(r.stdout.toString()) as { id: string; server_ids: string[] };
  expect(pool.id).toBe(POOL_ID);
  expect(pool.server_ids).toEqual([SERVER_ID]);
});

test("build-pools get of an unknown name exits 5 and lists the known pools", async () => {
  const r = await $`bun run src/index.ts build-pools get nope`.env(env()).nothrow().quiet();
  expect(r.exitCode).toBe(5);
  expect(r.stderr.toString()).toContain("available: pool-a");
});

test("build-pools create posts a persistent pool with the resolved builders", async () => {
  const r = await $`bun run src/index.ts -o json build-pools create --name pool-b --server ${SERVER_ID} --max-concurrent 4`
    .env(env()).quiet();
  const pool = JSON.parse(r.stdout.toString()) as Record<string, unknown>;
  expect(pool["name"]).toBe("pool-b");
  expect(pool["mode"]).toBe("persistent");
  expect(pool["server_ids"]).toEqual([SERVER_ID]);
  expect(pool["max_concurrent_builds"]).toBe(4);
});

test("build-pools create without --server exits 2", async () => {
  const r = await $`bun run src/index.ts build-pools create --name pool-b`.env(env()).nothrow().quiet();
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("--server");
});

test("build-pools create with --max-concurrent out of range exits 2", async () => {
  const r = await $`bun run src/index.ts build-pools create --name pool-b --server ${SERVER_ID} --max-concurrent 17`
    .env(env()).nothrow().quiet();
  expect(r.exitCode).toBe(2);
});

test("build-pools create --mode ephemeral posts the Hetzner pool with a cent budget and resolved credential", async () => {
  const r = await $`bun run src/index.ts -o json build-pools create --name eph --mode ephemeral --cloud-credential hetzner-main --location fsn1 --server-type cx33 --fallback-type cpx22 --idle-policy ttl:15 --budget 25.50`
    .env(env()).quiet();
  const pool = JSON.parse(r.stdout.toString()) as Record<string, unknown>;
  expect(pool["mode"]).toBe("ephemeral");
  expect(pool["provider"]).toBe("hetzner");
  expect(pool["cloud_credential_id"]).toBe("66666666-6666-6666-6666-666666666666");
  expect(pool["fallback_server_types"]).toEqual(["cpx22"]);
  expect(pool["idle_policy"]).toBe("ttl:15");
  expect(pool["monthly_budget_cents"]).toBe(2550);
  expect(pool["server_ids"]).toBeUndefined();
});

test("build-pools estimate prints sub-cent hourly rates and the pricing snapshot", async () => {
  const r = await $`bun run src/index.ts -o text build-pools estimate --cloud-credential hetzner-main --location fsn1 --server-type cx33`
    .env(env()).quiet();
  const out = r.stdout.toString();
  expect(out).toContain("EUR 0.0144/h");
  expect(out).toContain("EUR 0.0008/h");
  expect(out).toContain("from 2026-10-24");
});

test("build-pools estimate with neither a pool nor unsaved settings exits 2", async () => {
  const r = await $`bun run src/index.ts build-pools estimate --location fsn1`.env(env()).nothrow().quiet();
  expect(r.exitCode).toBe(2);
});

test("build-pools costs reports budget usage past 80% for a pool", async () => {
  await $`bun run src/index.ts -o json build-pools create --name eph --mode ephemeral --cloud-credential hetzner-main --location fsn1 --server-type cx33 --budget 25`
    .env(env()).quiet();
  const r = await $`bun run src/index.ts -o text build-pools costs eph`.env(env()).quiet();
  const out = r.stdout.toString();
  expect(out).toContain("EUR 21.00 of EUR 25.00 (84%)");
  expect(out).toContain("over 80%");
});

test("build-pools builders flags a builder past its max lifetime", async () => {
  const r = await $`bun run src/index.ts -o json build-pools builders pool-a`.env(env()).quiet();
  const builders = rows(r.stdout);
  const warning = (id: string): unknown => builders.find((b) => b["id"] === id)?.["warning"];
  expect(warning("old-builder")).toBe("past max lifetime");
  expect(warning("fresh-builder")).toBe("");
});

test("build-pools reconcile uploads the raw CSV as text/csv and prints differences", async () => {
  const file = join(tmp, "statement.csv");
  await Bun.write(file, "server_id;currency;net\n4711;EUR;1,50\n");
  const r = await $`bun run src/index.ts -o text build-pools reconcile --file ${file} --cloud-credential hetzner-main --month 2026-09`
    .env(env()).quiet();
  expect(gw.statementUploads).toHaveLength(1);
  expect(gw.statementUploads[0]?.contentType).toBe("text/csv");
  expect(gw.statementUploads[0]?.body).toBe("server_id;currency;net\n4711;EUR;1,50\n");
  expect(gw.statementUploads[0]?.search).toContain("month=2026-09");
  const out = r.stdout.toString();
  expect(out).toContain("+EUR 0.30");
  expect(out).toContain("not_a_server");
});

test("build-pools set changes only the flags given", async () => {
  const r = await $`bun run src/index.ts -o json build-pools set pool-a --max-concurrent 3`.env(env()).quiet();
  const pool = JSON.parse(r.stdout.toString()) as Record<string, unknown>;
  expect(pool["max_concurrent_builds"]).toBe(3);
  expect(pool["name"]).toBe("pool-a");
});

test("build-pools set with no flags exits 2", async () => {
  const r = await $`bun run src/index.ts build-pools set pool-a`.env(env()).nothrow().quiet();
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("no fields to update");
});

test("build-pools rm --yes deletes the pool", async () => {
  const rm = await $`bun run src/index.ts build-pools rm pool-a --yes`.env(env()).quiet();
  expect(rm.stdout.toString()).toContain("✓ build pool removed");
  const got = await $`bun run src/index.ts build-pools get ${POOL_ID}`.env(env()).nothrow().quiet();
  expect(got.exitCode).not.toBe(0);
});

test("build-pools rm without --yes in non-TTY exits non-zero", async () => {
  const rm = await $`bun run src/index.ts build-pools rm pool-a`.env(env()).nothrow().quiet();
  expect(rm.exitCode).not.toBe(0);
});

test("builds ls lists every build, with the app slug and short commit", async () => {
  const r = await $`bun run src/index.ts builds ls`.env(env()).quiet();
  const out = r.stdout.toString();
  expect(out).toContain("app-1");
  expect(out).toContain("abcdef1");
  expect(out).toContain("queued");
});

test("builds ls --app asks the API for that application only", async () => {
  const r = await $`bun run src/index.ts -o json builds ls --app app-1`.env(env()).quiet();
  expect(rows(r.stdout).map((b) => b["status"]).sort()).toEqual(["failed", "succeeded"]);
});

test("builds ls --status keeps only matching builds", async () => {
  const r = await $`bun run src/index.ts -o json builds ls --status failed`.env(env()).quiet();
  expect(rows(r.stdout).map((b) => b["id"])).toEqual([FAILED_BUILD_ID]);
});

test("builds ls --status bogus exits 2", async () => {
  const r = await $`bun run src/index.ts builds ls --status bogus`.env(env()).nothrow().quiet();
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("builder_lost");
});

test("builds get shows one build", async () => {
  const r = await $`bun run src/index.ts -o json builds get ${QUEUED_BUILD_ID}`.env(env()).quiet();
  const build = JSON.parse(r.stdout.toString()) as Record<string, unknown>;
  expect(build["status"]).toBe("queued");
  expect(build["queue_position"]).toBe(1);
});

test("builds logs prints the log lines", async () => {
  const r = await $`bun run src/index.ts builds logs ${FAILED_BUILD_ID}`.env(env()).quiet();
  expect(r.stdout.toString()).toContain("FROM node:22");
});

test("builds cancel requests cancellation and reports the status", async () => {
  const r = await $`bun run src/index.ts builds cancel ${QUEUED_BUILD_ID}`.env(env()).quiet();
  expect(r.stdout.toString()).toContain("✓ cancel requested");
  expect(r.stdout.toString()).toContain("cancelled");
});

test("servers set-role patches the role", async () => {
  const r = await $`bun run src/index.ts servers set-role ${SERVER_ID} build`.env(env()).quiet();
  expect(r.stdout.toString()).toContain("✓ role updated: runtime → build");
});

test("servers set-role with an unknown role exits 2", async () => {
  const r = await $`bun run src/index.ts servers set-role ${SERVER_ID} bogus`.env(env()).nothrow().quiet();
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("runtime, build, both");
});
