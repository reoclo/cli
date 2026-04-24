// tests/integration/auth-lifecycle.test.ts
import { expect, test, beforeEach } from "bun:test";
import { $ } from "bun";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reoclo-it-"));
});

test("login → whoami → logout (file store)", async () => {
  const env = { ...process.env, REOCLO_CONFIG_DIR: tmp };

  // Login should succeed and save profile + token to file store
  await $`bun run src/index.ts login --token rk_t_fake --no-keyring`.env(env);

  // whoami should print stub identity
  const who = await $`bun run src/index.ts whoami`.env(env).quiet();
  expect(who.stdout.toString()).toContain("type:    tenant");

  // logout removes everything
  await $`bun run src/index.ts logout`.env(env);

  // whoami after logout should exit 3
  const after = await $`bun run src/index.ts whoami`.env(env).nothrow().quiet();
  expect(after.exitCode).toBe(3);
});
