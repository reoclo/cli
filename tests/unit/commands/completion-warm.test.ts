// tests/unit/commands/completion-warm.test.ts
//
// Unit tests for warmCache. We stub only the two leaf dependencies
// (fetchCompletionIndex, writeAllSlices) via mock.module and drive the real
// bootstrap() via env vars + a minimal config file so we never mock the
// bootstrap module itself (which would pollute bootstrap.test.ts when bun
// shares the module registry across files in the same worker).

import { describe, expect, test, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NotFoundError } from "../../../src/client/errors";

// ---------------------------------------------------------------------------
// Stub state — mutated per-test via resetStubs().
// ---------------------------------------------------------------------------
let _fetchResult: unknown = {};
let _fetchThrows: Error | null = null;
let _writeAllSlicesCalled = false;
let _writeAllSlicesArg: unknown = null;

// ---------------------------------------------------------------------------
// Capture the original module exports BEFORE mocking so afterAll can restore
// them. Mocks are process-global in bun, so leakage across test files
// (observed on Linux CI but not always locally) breaks any subsequent test
// that imports the real index-client / cache modules.
// ---------------------------------------------------------------------------
const realIndexClient = await import("../../../src/completion/index-client");
const realCache = await import("../../../src/completion/cache");

// ---------------------------------------------------------------------------
// Stub only the two leaf modules; bootstrap itself is the real implementation
// driven by REOCLO_CONFIG_DIR + a minimal config.json.
// ---------------------------------------------------------------------------
await mock.module("../../../src/completion/index-client", () => ({
  fetchCompletionIndex: (_client: unknown, _tid: string): Promise<unknown> => {
    if (_fetchThrows !== null) return Promise.reject(_fetchThrows);
    return Promise.resolve(_fetchResult);
  },
  parseIndexResponse: (payload: unknown): unknown => payload,
}));

await mock.module("../../../src/completion/cache", () => ({
  writeAllSlices: (slices: unknown): void => {
    _writeAllSlicesCalled = true;
    _writeAllSlicesArg = slices;
  },
  writeSlice: (): void => {},
  writeEnvKeys: (): void => {},
  getSlice: (): unknown[] => [],
  getEnvKeys: (): string[] => [],
  sliceAge: (): number => Infinity,
}));

// Import the module under test AFTER stubs are registered.
const { warmCache } = await import("../../../src/commands/completion");

// ---------------------------------------------------------------------------
// Env / config helpers
// ---------------------------------------------------------------------------
const MINIMAL_CONFIG = JSON.stringify({
  active_profile: "default",
  profiles: {
    default: {
      token: "rk_t_testtoken",
      api_url: "https://api.reoclo.com",
      tenant_id: "tenant-test-1",
    },
  },
});

let tmpConfigDir = "";
let savedConfigDir: string | undefined;

beforeEach(() => {
  resetStubs();

  tmpConfigDir = mkdtempSync(join(tmpdir(), "rc-warm-"));
  writeFileSync(join(tmpConfigDir, "config.json"), MINIMAL_CONFIG, "utf8");

  savedConfigDir = process.env.REOCLO_CONFIG_DIR;
  process.env.REOCLO_CONFIG_DIR = tmpConfigDir;

  // Remove any ambient credentials so bootstrap uses the profile above.
  delete process.env.REOCLO_API_KEY;
  delete process.env.REOCLO_AUTOMATION_KEY;
  delete process.env.REOCLO_PROFILE;
});

afterEach(() => {
  if (savedConfigDir === undefined) {
    delete process.env.REOCLO_CONFIG_DIR;
  } else {
    process.env.REOCLO_CONFIG_DIR = savedConfigDir;
  }
  try {
    rmSync(tmpConfigDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// Restore the real modules after all tests in this file so other test files
// that share the bun worker are not affected. The previous version called
// `import("...")` inside the factory which resolves against the *already-
// mocked* registry — so it just re-mocked. The fix captures the real exports
// at file load time (above) and replays them here.
afterAll(async () => {
  await mock.module("../../../src/completion/index-client", () => realIndexClient);
  await mock.module("../../../src/completion/cache", () => realCache);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resetStubs(): void {
  _fetchResult = { apps: [{ id: "a1", value: "myapp", name: "My App", desc: "" }] };
  _fetchThrows = null;
  _writeAllSlicesCalled = false;
  _writeAllSlicesArg = null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("warmCache", () => {
  test("success: returns true and calls writeAllSlices with the fetched slices", async () => {
    const slices = { apps: [{ id: "a1", value: "myapp", name: "My App", desc: "" }] };
    _fetchResult = slices;

    const result = await warmCache(undefined);

    expect(result).toBe(true);
    expect(_writeAllSlicesCalled).toBe(true);
    expect(_writeAllSlicesArg).toEqual(slices);
  });

  test("NotFoundError: returns false and does NOT throw", async () => {
    _fetchThrows = new NotFoundError("not found", "/tenants/tenant-test-1/completion-index");

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
    expect(_writeAllSlicesCalled).toBe(false);
  });

  test("generic Error: re-throws and does NOT call writeAllSlices", async () => {
    _fetchThrows = new Error("network failure");

    let caught: unknown = null;
    try {
      await warmCache(undefined);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("network failure");
    expect(_writeAllSlicesCalled).toBe(false);
  });
});
