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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-relocate-"));
  seedTenantProfile({ configDir: tmp, apiUrl: gw.url, token: gw.token });
});

afterEach(() => {
  gw.stop();
});

function env(): Record<string, string | undefined> {
  return { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
}

async function plan(): Promise<string> {
  const out = await $`bun run src/index.ts -o json relocate plan --app app-1 --stack files --to srv-1 --gate-before-cutover`
    .env(env()).quiet();
  return (JSON.parse(out.stdout.toString()) as { id: string }).id;
}

test("plan resolves names into exact bodies and never starts the run", async () => {
  // Given an app and a stack named by slug, when planning.
  await plan();
  // Then one plan request carries resolved IDs and options, and nothing else was sent.
  expect(gw.relocationRequests.map((r) => r.path)).toEqual(["plan"]);
  const body = gw.relocationRequests[0]!.body;
  expect(body.items).toEqual([
    { kind: "app", id: "00000000-0000-0000-0000-00000000cccc" },
    { kind: "stack", id: "00000000-0000-0000-0000-00000000dddd" },
  ]);
  expect(body.target_server_id).toBe("00000000-0000-0000-0000-00000000bbbb");
  expect(body.options).toEqual({ gate_before_cutover: true, auto_commit: true, volumes: [] });
  expect(typeof body.request_id).toBe("string");
});

test("run without --yes in a pipe refuses and sends nothing", async () => {
  // Given a planned run, when started non-interactively without --yes.
  const id = await plan();
  const r = await $`bun run src/index.ts relocate run ${id} --plan-hash ${"a".repeat(64)}`.env(env()).nothrow().quiet();
  // Then it exits with a usage error and no start request exists.
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("--yes");
  expect(gw.relocationRequests.map((r) => r.path)).toEqual(["plan"]);
});

test("run --yes sends the hash, the latest revision and fresh request IDs", async () => {
  // Given a planned run, when it is started twice with --yes.
  const id = await plan();
  const first = await $`bun run src/index.ts relocate run ${id} --plan-hash ${"a".repeat(64)} --yes`.env(env()).nothrow().quiet();
  const second = await $`bun run src/index.ts relocate run ${id} --cutover --yes`.env(env()).nothrow().quiet();
  // Then the start carries the confirmed plan identity, and each call has its own request ID.
  expect(first.exitCode).toBe(0);
  const [, start, cutover] = gw.relocationRequests;
  expect(start!.body).toMatchObject({ revision: 1, plan_revision: 1, plan_hash: "a".repeat(64) });
  expect(cutover!.body.revision).toBe(2);
  expect(start!.body.request_id).not.toBe(cutover!.body.request_id);
  expect(second.exitCode).toBe(0);
});

test("run demands exactly one mode", async () => {
  const id = await plan();
  const r = await $`bun run src/index.ts relocate run ${id} --cutover --resume --yes`.env(env()).nothrow().quiet();
  expect(r.exitCode).toBe(2);
});

test("status --watch prints events and stops at the start decision", async () => {
  // Given a planned run that waits for a start.
  const id = await plan();
  // When it is watched.
  const r = await $`bun run src/index.ts relocate status ${id} --watch`.env(env()).nothrow().quiet();
  // Then every event is printed once and the watch returns.
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString().match(/event \d/g)).toEqual(["event 1", "event 2"]);
});

test("unknown relocation exits not-found", async () => {
  const r = await $`bun run src/index.ts relocate status 00000000-0000-0000-0000-000000000999`.env(env()).nothrow().quiet();
  expect(r.exitCode).toBe(5);
});

test("an automation key cannot run relocate", async () => {
  const r = await $`bun run src/index.ts relocate status`
    .env({ ...process.env, REOCLO_CONFIG_DIR: mkdtempSync(join(tmpdir(), "reoclo-relocate-key-")), REOCLO_AUTOMATION_KEY: "rk_a_test", REOCLO_API_URL: gw.url })
    .nothrow().quiet();
  expect(r.exitCode).toBe(4);
});
