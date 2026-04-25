// tests/integration/write-commands.test.ts
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
  tmp = mkdtempSync(join(tmpdir(), "reoclo-w-"));
  await $`bun run src/index.ts login --token ${gw.token} --api ${gw.url} --no-keyring`.env({
    ...process.env,
    REOCLO_CONFIG_DIR: tmp,
    REOCLO_CACHE_DIR: join(tmp, "cache"),
  }).quiet();
});

afterEach(() => {
  gw.stop();
});

const baseEnv = (): Record<string, string> => ({
  ...process.env,
  REOCLO_CONFIG_DIR: tmp,
  REOCLO_CACHE_DIR: join(tmp, "cache"),
});

test("apps deploy returns a queued deployment id", async () => {
  const r = await $`bun run src/index.ts apps deploy app-1`.env(baseEnv()).quiet();
  expect(r.stdout.toString()).toContain("queued");
});

test("apps deploy --wait completes when status flips to succeeded", async () => {
  const r = await $`bun run src/index.ts apps deploy app-1 --wait`.env(baseEnv()).quiet();
  expect(r.stdout.toString()).toContain("succeeded");
}, 15000);

test("env set + ls + rm round-trip", async () => {
  await $`bun run src/index.ts env set --app app-1 FOO=bar BAZ=qux`.env(baseEnv()).quiet();

  const lsBefore = await $`bun run src/index.ts env ls --app app-1`.env(baseEnv()).quiet();
  const out = lsBefore.stdout.toString();
  expect(out).toContain("FOO");
  expect(out).toContain("BAZ");

  await $`bun run src/index.ts env rm --app app-1 FOO`.env(baseEnv()).quiet();

  const lsAfter = await $`bun run src/index.ts env ls --app app-1`.env(baseEnv()).quiet();
  const outAfter = lsAfter.stdout.toString();
  expect(outAfter).not.toContain("FOO");
  expect(outAfter).toContain("BAZ");
});

test("env get exits 1 with informative message", async () => {
  const r = await $`bun run src/index.ts env get --app app-1 FOO`.env(baseEnv()).nothrow().quiet();
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("write-only");
});

test("domains add + ls round-trip", async () => {
  const add = await $`bun run src/index.ts domains add example.com`.env(baseEnv()).quiet();
  expect(add.stdout.toString()).toContain("example.com");
  expect(add.stdout.toString()).toContain("pending");

  const ls = await $`bun run src/index.ts domains ls`.env(baseEnv()).quiet();
  expect(ls.stdout.toString()).toContain("example.com");
});

test("apps restart prints the container name on success", async () => {
  const r = await $`bun run src/index.ts apps restart app-1`.env(baseEnv()).quiet();
  expect(r.stdout.toString()).toContain("reoclo-acme-app-1");
  expect(r.stdout.toString()).toContain("✓ restarted");
});

test("apps logs prints log lines for the resolved container", async () => {
  const r = await $`bun run src/index.ts apps logs app-1 --tail 50`.env(baseEnv()).quiet();
  const out = r.stdout.toString();
  expect(out).toContain("boot ok");
  expect(out).toContain("slow query");
});

test("apps logs --output json returns the full structured response", async () => {
  const r = await $`bun run src/index.ts apps logs app-1 -o json`.env(baseEnv()).quiet();
  const parsed = JSON.parse(r.stdout.toString()) as {
    entries: Array<{ message: string }>;
    server_id: string;
  };
  expect(parsed.entries.length).toBe(2);
  expect(parsed.server_id).toBeDefined();
});

test("exec runs a command and prints stdout", async () => {
  const r = await $`bun run src/index.ts exec srv-1 -- echo hello`.env(baseEnv()).quiet();
  expect(r.stdout.toString()).toContain("ran: echo hello");
  expect(r.exitCode).toBe(0);
});

test("exec exits with the remote command's non-zero exit code", async () => {
  const r = await $`bun run src/index.ts exec srv-1 -- fail-now`
    .env(baseEnv())
    .nothrow()
    .quiet();
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("boom");
});

test("exec with no command exits 2 with a hint", async () => {
  const r = await $`bun run src/index.ts exec srv-1`.env(baseEnv()).nothrow().quiet();
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("no command given");
});
