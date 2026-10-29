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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-dcancel-"));
  process.env.REOCLO_CACHE_DIR = join(tmp, "cache");
  seedTenantProfile({ configDir: tmp, apiUrl: gw.url, token: gw.token });
});

afterEach(() => {
  gw.stop();
});

function env(): Record<string, string | undefined> {
  return { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
}

const TENANT = "00000000-0000-0000-0000-00000000aaaa";
const STACK_A = "88888888-0000-0000-0000-000000000001";
const RUN_3 = "99999999-0000-0000-0000-000000000003";
const RUN_2 = "99999999-0000-0000-0000-000000000002";
const RUN_4 = "99999999-0000-0000-0000-000000000004";
const APP_DEP_RUNNING = "aaaaaaaa-0000-0000-0000-000000000001";
const APP_DEP_DONE = "aaaaaaaa-0000-0000-0000-000000000002";
const APP_DEP_OTHER_APP = "aaaaaaaa-0000-0000-0000-000000000003";

const groupCancelPath = (run: string): string =>
  `/tenants/${TENANT}/application-groups/${STACK_A}/deployments/${run}/cancel`;

test("groups cancel by number cancels that run and prints status and message", async () => {
  const r = await $`bun run src/index.ts groups cancel stack-a 3`.env(env()).quiet();
  const out = r.stdout.toString();
  expect(gw.cancelRequests).toEqual([groupCancelPath(RUN_3)]);
  expect(out).toContain("cancel requested for group deployment #3 (status: running)");
  expect(out).toContain("The worker will stop at its next step.");
});

test("groups cancel by number reports an immediate cancel", async () => {
  const r = await $`bun run src/index.ts groups cancel stack-a 2`.env(env()).quiet();
  expect(gw.cancelRequests).toEqual([groupCancelPath(RUN_2)]);
  expect(r.stdout.toString()).toContain("(status: cancelled)");
});

test("groups cancel by group deployment id skips the lookup", async () => {
  await $`bun run src/index.ts groups cancel stack-a ${RUN_3}`.env(env()).quiet();
  expect(gw.cancelRequests).toEqual([groupCancelPath(RUN_3)]);
});

test("groups cancel without a run targets the newest one still running", async () => {
  // #4 succeeded, #3 running, #2 pending: the newest non-terminal run is #3.
  const r = await $`bun run src/index.ts groups cancel stack-a`.env(env()).quiet();
  expect(gw.cancelRequests).toEqual([groupCancelPath(RUN_3)]);
  expect(r.stdout.toString()).toContain("group deployment #3");
});

test("groups cancel without a run fails clearly when nothing is running", async () => {
  const r = await $`bun run src/index.ts groups cancel stack-idle`.env(env()).nothrow().quiet();
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("no running deployment in group 'stack-idle'");
  expect(r.stderr.toString()).toContain("latest: #1 succeeded");
  expect(gw.cancelRequests).toEqual([]);
});

test("groups cancel of a finished run surfaces the 409 detail and exits 1", async () => {
  const r = await $`bun run src/index.ts groups cancel stack-a 4`.env(env()).nothrow().quiet();
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("Deployment already finished");
  expect(gw.cancelRequests).toEqual([groupCancelPath(RUN_4)]);
});

test("groups cancel of an unknown run number exits 5 without calling cancel", async () => {
  const r = await $`bun run src/index.ts groups cancel stack-a 99`.env(env()).nothrow().quiet();
  expect(r.exitCode).toBe(5);
  expect(r.stderr.toString()).toContain("deployment '99' not found in group 'stack-a'");
  expect(gw.cancelRequests).toEqual([]);
});

test("groups cancel of an unknown group exits 5 and lists the known groups", async () => {
  const r = await $`bun run src/index.ts groups cancel nope`.env(env()).nothrow().quiet();
  expect(r.exitCode).toBe(5);
  expect(r.stderr.toString()).toContain("available: stack-a, stack-idle");
});

test("groups cancel -o json passes the API answer through", async () => {
  const r = await $`bun run src/index.ts -o json groups cancel stack-a 3`.env(env()).quiet();
  expect(JSON.parse(r.stdout.toString())).toEqual({
    id: RUN_3,
    status: "running",
    cancel_requested_at: "2026-10-29T12:00:00Z",
    message: "Cancel requested. The worker will stop at its next step.",
  });
});

test("deployments cancel posts to the tenant route and prints status and message", async () => {
  const r = await $`bun run src/index.ts deployments cancel ${APP_DEP_RUNNING}`.env(env()).quiet();
  expect(gw.cancelRequests).toEqual([`/tenants/${TENANT}/deployments/${APP_DEP_RUNNING}/cancel`]);
  const out = r.stdout.toString();
  expect(out).toContain(`cancel requested for deployment ${APP_DEP_RUNNING} (status: building)`);
  expect(out).toContain("The worker will stop at its next step.");
});

test("deployments cancel -o json passes the API answer through", async () => {
  const r = await $`bun run src/index.ts -o json deployments cancel ${APP_DEP_RUNNING}`
    .env(env())
    .quiet();
  const body = JSON.parse(r.stdout.toString()) as Record<string, unknown>;
  expect(body["id"]).toBe(APP_DEP_RUNNING);
  expect(body["status"]).toBe("building");
  expect(body["cancel_requested_at"]).toBe("2026-10-29T12:00:00Z");
  expect(typeof body["message"]).toBe("string");
});

test("deployments cancel of a finished deployment surfaces the 409 detail and exits 1", async () => {
  const r = await $`bun run src/index.ts deployments cancel ${APP_DEP_DONE}`
    .env(env())
    .nothrow()
    .quiet();
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("Deployment already finished");
});

test("deployments cancel of an unknown id exits 5", async () => {
  const r = await $`bun run src/index.ts deployments cancel 00000000-0000-0000-0000-0000000000ff`
    .env(env())
    .nothrow()
    .quiet();
  expect(r.exitCode).toBe(5);
  expect(r.stderr.toString()).toContain("Deployment not found");
});

test("deployments cancel --app cancels when the deployment belongs to that app", async () => {
  const r = await $`bun run src/index.ts deployments cancel ${APP_DEP_RUNNING} --app app-1`
    .env(env())
    .quiet();
  expect(r.stdout.toString()).toContain("cancel requested");
  expect(gw.cancelRequests).toHaveLength(1);
});

test("deployments cancel --app refuses a deployment of another app without cancelling", async () => {
  const r = await $`bun run src/index.ts deployments cancel ${APP_DEP_OTHER_APP} --app app-1`
    .env(env())
    .nothrow()
    .quiet();
  expect(r.exitCode).toBe(5);
  expect(gw.cancelRequests).toEqual([]);
});
