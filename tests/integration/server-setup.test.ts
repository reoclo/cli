// tests/integration/server-setup.test.ts
import { expect, test, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { $ } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startFakeGateway, type FakeGateway } from "../helpers/fake-gateway";
import { seedTenantProfile } from "../helpers/seed-profile";

// Each test launches the CLI from source, and a cold start can take seconds.
setDefaultTimeout(30_000);

let tmp: string;
let binDir: string;
let gw: FakeGateway;

// Stands in for OpenSSH: records what it was asked to run and exits as told.
const FAKE_SSH = `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_SSH_DIR/argv"
cat > "$FAKE_SSH_DIR/stdin"
exit "\${FAKE_SSH_EXIT:-0}"
`;

beforeEach(() => {
  gw = startFakeGateway();
  tmp = mkdtempSync(join(tmpdir(), "reoclo-srvsetup-"));
  binDir = join(tmp, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "ssh"), FAKE_SSH, { mode: 0o755 });
  process.env.REOCLO_CACHE_DIR = join(tmp, "cache");
  seedTenantProfile({ configDir: tmp, apiUrl: gw.url, token: gw.token });
});

afterEach(() => {
  gw.stop();
});

function env(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    FAKE_SSH_DIR: tmp,
    REOCLO_CONFIG_DIR: tmp,
    REOCLO_CACHE_DIR: join(tmp, "cache"),
    ...extra,
  };
}

const sshArgv = (): string[] => readFileSync(join(tmp, "argv"), "utf8").trim().split("\n");
const sshScript = (): string => readFileSync(join(tmp, "stdin"), "utf8");
const sshRan = (): boolean => existsSync(join(tmp, "argv"));

test("servers add --ssh sends the token over stdin and reports the connected server", async () => {
  const r = await $`bun run src/index.ts servers add --ssh root@203.0.113.9 --yes`.env(env()).quiet();

  expect(sshArgv()).toContain("root@203.0.113.9");
  expect(sshArgv().join(" ")).not.toContain("rt_secretvalue");
  expect(sshScript()).toContain("--token rt_secretvalue");
  expect(sshScript()).toContain("--install-url https://get.example.test");
  expect(sshScript()).toContain("--gateway wss://gateway.example.test/ws/runner");
  expect(sshScript()).toContain("--user ubuntu");
  expect(sshScript()).toContain("--harden");
  expect(sshScript()).toContain('> "$SETUP" || exit $?');
  expect(sshScript()).toContain("sudo -n");
  expect(gw.runnerTokenBodies).toEqual([{ label: "203.0.113.9" }]);
  expect(r.stdout.toString()).toContain("✓ server connected: srv-1");
  expect(r.stdout.toString()).toContain("Log in as ubuntu");
});

test("servers add uses a non-root SSH user as the admin user and honors --no-harden", async () => {
  await $`bun run src/index.ts servers add --ssh admin@203.0.113.9 --no-harden --yes`.env(env()).quiet();

  expect(sshScript()).toContain("--user admin");
  expect(sshScript()).not.toContain("--harden");
});

test("servers add without --ssh prints a command to paste and does not connect", async () => {
  const r = await $`bun run src/index.ts servers add --name web-2`.env(env()).quiet();

  expect(sshRan()).toBe(false);
  expect(r.stdout.toString()).toContain("--token rt_secretvalue");
  expect(r.stdout.toString()).not.toContain("sudo -n");
  expect(r.stdout.toString()).not.toContain("mktemp");
});

test("servers add without --ssh needs a name and creates no token", async () => {
  const r = await $`bun run src/index.ts servers add`.env(env()).nothrow().quiet();

  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("--name");
  expect(gw.runnerTokenBodies).toEqual([]);
});

test("servers add --cloud-init prints a user-data script", async () => {
  const r = await $`bun run src/index.ts servers add --name web-2 --cloud-init`.env(env()).quiet();

  expect(r.stdout.toString()).toStartWith("#!/bin/bash");
  expect(r.stdout.toString()).not.toContain("SSH_CLIENT");
});

test("servers add revokes the token when SSH cannot connect", async () => {
  const r = await $`bun run src/index.ts servers add --ssh root@203.0.113.9 --yes`
    .env(env({ FAKE_SSH_EXIT: "255" }))
    .nothrow()
    .quiet();

  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("could not connect");
  expect(gw.runnerTokenRevokes).toEqual(["tok-1"]);
});

test("servers add --ssh without --yes aborts before creating a token", async () => {
  const r = await $`bun run src/index.ts servers add --ssh root@203.0.113.9`.env(env()).nothrow().quiet();

  expect(r.exitCode).not.toBe(0);
  expect(gw.runnerTokenBodies).toEqual([]);
  expect(sshRan()).toBe(false);
});

test("servers add --check creates no token and passes --check", async () => {
  await $`bun run src/index.ts servers add --ssh root@203.0.113.9 --check --install-url https://get.example.test`
    .env(env())
    .quiet();

  expect(gw.runnerTokenBodies).toEqual([]);
  expect(sshScript()).toContain("--check");
  expect(sshScript()).not.toContain("--yes");
});

test("servers add rejects an SSH destination that ssh would read as an option", async () => {
  const r = await $`bun run src/index.ts servers add --ssh=-oProxyCommand=x --yes`.env(env()).nothrow().quiet();

  expect(r.exitCode).toBe(2);
  expect(sshRan()).toBe(false);
});

test("servers harden connects as the admin user at the server's IP", async () => {
  const r = await $`bun run src/index.ts servers harden srv-1 --yes --install-url https://get.example.test`
    .env(env())
    .quiet();

  expect(sshArgv()).toContain("ubuntu@203.0.113.20");
  expect(sshScript()).toContain("--harden-only");
  expect(sshScript()).toContain("--harden \\");
  expect(sshScript()).toContain("--user ubuntu");
  expect(r.stdout.toString()).toContain("✓ hardened: srv-1");
});

test("an explicit key is the only one ssh offers", async () => {
  await $`bun run src/index.ts servers harden srv-1 -i /tmp/key --port 2222 --yes --install-url https://get.example.test`
    .env(env())
    .quiet();

  const argv = sshArgv().join(" ");
  expect(argv).toContain("-i /tmp/key -o IdentitiesOnly=yes");
  expect(argv).toContain("-p 2222");
});

test("servers harden --ssh-only stops at the SSH lockdown", async () => {
  await $`bun run src/index.ts servers harden srv-1 --ssh-only --yes --install-url https://get.example.test`
    .env(env())
    .quiet();

  expect(sshScript()).toContain("--harden-ssh");
  expect(sshScript()).not.toContain("fail2ban");
});

test("servers harden --print does not connect", async () => {
  const r = await $`bun run src/index.ts servers harden srv-1 --print --install-url https://get.example.test`
    .env(env())
    .quiet();

  expect(sshRan()).toBe(false);
  expect(r.stdout.toString()).toContain("--harden-only");
});

test("servers harden without --yes aborts non-interactively", async () => {
  const r = await $`bun run src/index.ts servers harden srv-1 --install-url https://get.example.test`
    .env(env())
    .nothrow()
    .quiet();

  expect(r.exitCode).not.toBe(0);
  expect(sshRan()).toBe(false);
});

test("servers rm --yes decommissions the server", async () => {
  const r = await $`bun run src/index.ts servers rm srv-1 --yes`.env(env()).quiet();

  expect(gw.serverDeletes).toHaveLength(1);
  expect(r.stdout.toString()).toContain("✓ decommissioned: srv-1");
});

test("servers rm without --yes aborts non-interactively", async () => {
  const r = await $`bun run src/index.ts servers rm srv-1`.env(env()).nothrow().quiet();

  expect(r.exitCode).not.toBe(0);
  expect(gw.serverDeletes).toEqual([]);
});
