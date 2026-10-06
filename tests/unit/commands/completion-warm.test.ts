// tests/unit/commands/completion-warm.test.ts
//
// Unit tests for warmCache. The real bootstrap(), index-client and completion
// cache all run: the API is a throwaway local HTTP server and the cache lives
// in a temp REOCLO_CACHE_DIR.
//
// Do NOT mock.module() the cache or index-client here. bun registers every
// file's top-level mocks before any test runs and never undoes them, so a stub
// leaks into every other file that uses the real modules (bootstrap,
// require-tenant-id, resolve) in a full `bun test` run.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { warmCache } from "../../../src/commands/completion";
import { getSlice, setActiveOrg } from "../../../src/completion/cache";

// ---------------------------------------------------------------------------
// Fake API: serves the completion index and counts requests per test.
// ---------------------------------------------------------------------------
const INDEX_PATH = "/tenants/tenant-test-1/completion-index";

let indexStatus = 200;
let indexBody: unknown = {};
let indexRequests = 0;
let server: ReturnType<typeof Bun.serve> | undefined;

const APP_ENTRY = { id: "a1", value: "myapp", name: "My App", desc: "" };

// ---------------------------------------------------------------------------
// Env / config helpers
// ---------------------------------------------------------------------------
function profileConfig(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    active_profile: "default",
    profiles: {
      default: {
        token: "rk_t_testtoken",
        api_url: `http://127.0.0.1:${server?.port ?? 0}`,
        tenant_id: "tenant-test-1",
        ...extra,
      },
    },
  });
}

let tmpConfigDir = "";
let tmpCacheDir = "";
let savedConfigDir: string | undefined;
let savedCacheDir: string | undefined;

beforeEach(() => {
  indexStatus = 200;
  indexBody = { resources: { apps: [APP_ENTRY] } };
  indexRequests = 0;
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith(INDEX_PATH)) return new Response("not found", { status: 404 });
      indexRequests += 1;
      if (indexStatus !== 200) return Response.json({ detail: "nope" }, { status: indexStatus });
      return Response.json(indexBody);
    },
  });

  tmpConfigDir = mkdtempSync(join(tmpdir(), "rc-warm-"));
  tmpCacheDir = mkdtempSync(join(tmpdir(), "rc-warm-cache-"));
  writeFileSync(join(tmpConfigDir, "config.json"), profileConfig(), "utf8");

  savedConfigDir = process.env.REOCLO_CONFIG_DIR;
  savedCacheDir = process.env.REOCLO_CACHE_DIR;
  process.env.REOCLO_CONFIG_DIR = tmpConfigDir;
  process.env.REOCLO_CACHE_DIR = tmpCacheDir;
  setActiveOrg(undefined, undefined);

  // Remove any ambient credentials so bootstrap uses the profile above.
  delete process.env.REOCLO_API_KEY;
  delete process.env.REOCLO_AUTOMATION_KEY;
  delete process.env.REOCLO_PROFILE;
});

afterEach(async () => {
  await server?.stop(true);
  server = undefined;
  if (savedConfigDir === undefined) delete process.env.REOCLO_CONFIG_DIR;
  else process.env.REOCLO_CONFIG_DIR = savedConfigDir;
  if (savedCacheDir === undefined) delete process.env.REOCLO_CACHE_DIR;
  else process.env.REOCLO_CACHE_DIR = savedCacheDir;
  setActiveOrg(undefined, undefined);
  rmSync(tmpConfigDir, { recursive: true, force: true });
  rmSync(tmpCacheDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("warmCache", () => {
  // Explicit-org policy: an OAuth profile with no --org / $REOCLO_ORG / .reoclo
  // has no org to warm. The command fails with exit 4 before any fetch — it
  // must never warm the profile's login org on the sly.
  test("an OAuth profile with no org selected exits 4 without fetching", async () => {
    writeFileSync(
      join(tmpConfigDir, "config.json"),
      profileConfig({
        token: "oauth-access-token",
        auth_kind: "oauth",
        tenant_id: "tenant-login",
        tenant_slug: "login-org",
      }),
      "utf8",
    );
    delete process.env.REOCLO_ORG;
    let caught: unknown = null;
    try {
      await warmCache();
    } catch (e) {
      caught = e;
    }
    expect((caught as { exitCode?: number } | null)?.exitCode).toBe(4);
    expect(indexRequests).toBe(0);
    expect(getSlice("apps")).toEqual([]);
  });

  test("success: returns true and writes the fetched slices to the cache", async () => {
    const result = await warmCache(undefined);

    expect(result).toBe(true);
    expect(indexRequests).toBe(1);
    expect(getSlice("apps")).toEqual([APP_ENTRY]);
  });

  test("NotFoundError: returns false and does NOT throw", async () => {
    indexStatus = 404;

    // Suppress the expected stderr notice.
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (_chunk: unknown): boolean => true;

    let result: boolean | undefined;
    let threw = false;
    try {
      result = await warmCache(undefined);
    } catch {
      threw = true;
    } finally {
      process.stderr.write = origStderr;
    }

    expect(threw).toBe(false);
    expect(result).toBe(false);
    expect(getSlice("apps")).toEqual([]);
  });

  test("generic error: re-throws and does NOT write the cache", async () => {
    indexStatus = 400;

    let caught: unknown = null;
    try {
      await warmCache(undefined);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(indexRequests).toBe(1);
    expect(getSlice("apps")).toEqual([]);
  });
});
