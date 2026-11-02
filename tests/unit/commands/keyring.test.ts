// tests/unit/commands/keyring.test.ts
//
// `keyring migrate` / `keyring export` move both tokens. The keyring is an
// in-memory stand-in, so the developer's real OS keyring is never touched.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { registerKeyring } from "../../../src/commands/keyring";
import { withKeyringStore } from "../../../src/config/token-store";
import { MemoryStore } from "../../../src/config/keyring/memory";

let tmp: string;
let origLog: typeof console.log;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "keyring-cmd-"));
  process.env.REOCLO_CONFIG_DIR = tmp;
  origLog = console.log;
  console.log = () => {};
});

afterEach(() => {
  console.log = origLog;
  delete process.env.REOCLO_CONFIG_DIR;
});

function seed(profile: Record<string, unknown>): void {
  writeFileSync(
    join(tmp, "config.json"),
    JSON.stringify({
      active_profile: "default",
      profiles: {
        default: {
          api_url: "https://api.reoclo.com",
          token_type: "automation",
          tenant_id: "t-home",
          tenant_slug: "home",
          user_email: "dev@example.com",
          saved_at: "2026-01-01T00:00:00Z",
          auth_kind: "oauth",
          ...profile,
        },
      },
    }),
  );
}

function savedProfile(): Record<string, unknown> {
  const cfg = JSON.parse(readFileSync(join(tmp, "config.json"), "utf8")) as {
    profiles: { default: Record<string, unknown> };
  };
  return cfg.profiles.default;
}

async function run(keyring: MemoryStore, ...args: string[]): Promise<void> {
  const program = new Command();
  program.option("--profile <name>", "use a named profile");
  registerKeyring(program);
  await withKeyringStore(keyring, () => program.parseAsync(["node", "reoclo", "keyring", ...args]));
}

test("migrate moves the access and refresh tokens into the keyring", async () => {
  seed({ token: "access-1", refresh_token: "rt-1" });
  const keyring = new MemoryStore();

  await run(keyring, "migrate");

  expect(await keyring.get("default")).toBe("access-1");
  expect(await keyring.get("default-refresh")).toBe("rt-1");
  const p = savedProfile();
  expect(p.token).toBeUndefined();
  expect(p.refresh_token).toBeUndefined();
  expect(p.token_ref).toBe("keyring:reoclo-default");
  expect(p.refresh_token_ref).toBe("default-refresh");
});

test("migrate moves a refresh token whose access token is already gone", async () => {
  seed({ refresh_token: "rt-1" });
  const keyring = new MemoryStore();

  await run(keyring, "migrate");

  expect(await keyring.get("default-refresh")).toBe("rt-1");
  expect(savedProfile().token_ref).toBe("keyring:reoclo-default");
});

test("export moves both tokens back into config.json", async () => {
  seed({ token_ref: "keyring:reoclo-default", refresh_token_ref: "default-refresh" });
  const keyring = new MemoryStore();
  await keyring.set("default", "access-1");
  await keyring.set("default-refresh", "rt-1");

  await run(keyring, "export");

  const p = savedProfile();
  expect(p.token).toBe("access-1");
  expect(p.refresh_token).toBe("rt-1");
  expect(p.token_ref).toBeUndefined();
  expect(p.refresh_token_ref).toBeUndefined();
  expect(await keyring.get("default")).toBeNull();
  expect(await keyring.get("default-refresh")).toBeNull();
});
