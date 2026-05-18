// tests/unit/client/resolve.test.ts
//
// Uses mock.module to stub src/completion/cache so the tests are isolated from
// the file-system and from any other test file that also stubs that module
// (completion-warm.test.ts does the same — both files share the module registry
// in the same Bun worker, so the last mock.module wins per-import).

import { describe, expect, test, mock, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Stub state — controlled per-test via resetCache().
// ---------------------------------------------------------------------------
let _slice: Array<{ id: string; value: string; name: string; desc: string }> = [];
let _writtenSlice: Array<{ id: string; value: string; name: string; desc: string }> | null = null;

function resetCache(
  entries: Array<{ id: string; value: string; name: string; desc: string }> = [],
): void {
  _slice = entries;
  _writtenSlice = null;
}

// ---------------------------------------------------------------------------
// Mock the cache module before importing resolve.
// ---------------------------------------------------------------------------
await mock.module("../../../src/completion/cache", () => ({
  getSlice: (_kind: string) => _slice,
  writeSlice: (_kind: string, entries: typeof _slice) => {
    _writtenSlice = entries;
    // Also update the in-memory slice so subsequent getSlice calls see it.
    _slice = entries;
  },
  writeAllSlices: () => {},
  writeEnvKeys: () => {},
  getEnvKeys: () => [],
  sliceAge: () => Infinity,
}));

// Import the module under test AFTER stubs are registered.
const { resolveServer } = await import("../../../src/client/resolve");

// ---------------------------------------------------------------------------

const fakeClient = (servers: Array<Record<string, unknown>>) => ({
  get: <T>(_path: string): Promise<T> => Promise.resolve(servers as unknown as T),
});

describe("resolveServer", () => {
  beforeEach(() => {
    resetCache();
  });

  test("UUID input short-circuits without an API call", async () => {
    let called = false;
    const client = {
      get: <T>(): Promise<T> => {
        called = true;
        return Promise.resolve([] as unknown as T);
      },
    };
    const id = await resolveServer(
      client as never,
      "tenant-1",
      "00000000-0000-0000-0000-000000000001",
    );
    expect(id).toBe("00000000-0000-0000-0000-000000000001");
    expect(called).toBe(false);
  });

  test("cached identifier resolves without a network call", async () => {
    resetCache([
      { id: "srv-1", value: "reoclo-production", name: "Reoclo Production", desc: "Reoclo Production — active" },
    ]);
    let called = false;
    const client = {
      get: <T>(): Promise<T> => {
        called = true;
        return Promise.resolve([] as unknown as T);
      },
    };
    const id = await resolveServer(client as never, "t1", "reoclo-production");
    expect(id).toBe("srv-1");
    expect(called).toBe(false);
  });

  test("cache miss triggers fetch, resolves, and writes the slice", async () => {
    // Start with empty cache (cache miss).
    resetCache([]);
    const client = fakeClient([
      { id: "srv-1", slug: "reoclo-production", name: "Reoclo Production", status: "active" },
      { id: "srv-2", slug: "prawnwire-mail", name: "Prawnwire Mail", status: "active" },
    ]);
    const id = await resolveServer(client as never, "t1", "reoclo-production");
    expect(id).toBe("srv-1");
    // Verify that writeSlice was called and the slice is non-empty.
    expect(_writtenSlice).not.toBeNull();
    expect(_writtenSlice!.length).toBeGreaterThan(0);
    const entry = _writtenSlice!.find((e) => e.value === "reoclo-production");
    expect(entry).toBeDefined();
    expect(entry?.id).toBe("srv-1");
  });

  test("name input falls back when slug doesn't match", async () => {
    resetCache([]);
    const client = fakeClient([
      { id: "srv-1", slug: "reoclo-production", name: "Reoclo Production", status: "active" },
    ]);
    const id = await resolveServer(client as never, "t1", "Reoclo Production");
    expect(id).toBe("srv-1");
  });

  test("unknown identifier throws with exitCode 5", async () => {
    resetCache([]);
    const client = fakeClient([
      { id: "srv-1", slug: "reoclo-production", name: "Reoclo Production", status: "active" },
    ]);
    let threw = false;
    try {
      await resolveServer(client as never, "t1", "nope");
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/not found/);
      expect((err as Error & { exitCode: number }).exitCode).toBe(5);
    }
    expect(threw).toBe(true);
  });
});
