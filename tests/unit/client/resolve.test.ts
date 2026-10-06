// tests/unit/client/resolve.test.ts
//
// Drives the REAL completion cache against a throwaway REOCLO_CACHE_DIR.
// Do not mock.module() src/completion/cache here: bun registers every file's
// top-level mocks before any test runs and never undoes them, so a stub leaks
// into every other file that uses the real cache (bootstrap, require-tenant-id)
// in a full `bun test` run.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSlice, setActiveOrg, writeSlice } from "../../../src/completion/cache";
import type { Entry } from "../../../src/completion/types";
import { resolveServer, resolveApp, resolveRepo } from "../../../src/client/resolve";

// ---------------------------------------------------------------------------
// Cache state: a fresh empty cache dir per test; resetCache(entries) seeds the
// servers slice.
// ---------------------------------------------------------------------------
let cacheRoot: string | undefined;

function resetCache(entries: Entry[] = []): void {
  if (cacheRoot) rmSync(cacheRoot, { recursive: true, force: true });
  cacheRoot = mkdtempSync(join(tmpdir(), "resolve-cache-"));
  process.env.REOCLO_CACHE_DIR = cacheRoot;
  setActiveOrg(undefined, undefined);
  if (entries.length > 0) writeSlice("servers", entries);
}

afterEach(() => {
  if (cacheRoot) rmSync(cacheRoot, { recursive: true, force: true });
  cacheRoot = undefined;
  delete process.env.REOCLO_CACHE_DIR;
});

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
    // Verify that the fetched list was written through to the cache.
    const written = getSlice("servers");
    expect(written.length).toBeGreaterThan(0);
    const entry = written.find((e) => e.value === "reoclo-production");
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

  test("not-found error lists available candidate slugs from the fetched list", async () => {
    resetCache([]);
    const client = fakeClient([
      { id: "srv-1", slug: "reoclo-production", name: "Reoclo Production", status: "active" },
      { id: "srv-2", slug: "reoclo-lb-prod-01", name: "Reoclo Load Balancer", status: "active" },
      { id: "srv-3", slug: "devops-core-production", name: "DevOPS Core Production", status: "unreachable" },
    ]);
    const err = await resolveServer(client as never, "t1", "staging-server").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("staging-server");
    expect(msg).toContain("not found");
    expect(msg).toContain("reoclo-production");
    expect(msg).toContain("reoclo-lb-prod-01");
    expect(msg).toContain("devops-core-production");
  });

  test("not-found candidate list caps at 10 and notes the remainder", async () => {
    resetCache([]);
    const many = Array.from({ length: 13 }, (_, i) => ({
      id: `srv-${i + 1}`,
      slug: `srv-slug-${i + 1}`,
      name: `Server ${i + 1}`,
      status: "active",
    }));
    const client = fakeClient(many);
    const err = await resolveServer(client as never, "t1", "missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    // First 10 candidates appear
    for (let i = 1; i <= 10; i++) {
      expect(msg).toContain(`srv-slug-${i}`);
    }
    // 11th candidate does NOT appear inline
    expect(msg).not.toContain("srv-slug-11");
    // Remainder is summarised
    expect(msg).toMatch(/3 more|\(\+3\)/);
  });

  test("not-found with zero candidates does not add a candidate list", async () => {
    resetCache([]);
    const client = fakeClient([]);
    const err = await resolveServer(client as never, "t1", "anything").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("anything");
    expect(msg).toContain("not found");
    // No "available:" or candidate enumeration when the org has zero servers.
    expect(msg.toLowerCase()).not.toContain("available");
  });
});

// ---------------------------------------------------------------------------

const fakeAppClient = (items: Array<Record<string, unknown>>) => ({
  get: <T>(_path: string): Promise<T> =>
    Promise.resolve({ items, total: items.length, skip: 0, limit: 200 } as unknown as T),
});

describe("resolveApp", () => {
  beforeEach(() => {
    resetCache();
  });

  test("UUID input short-circuits without an API call", async () => {
    let called = false;
    const client = {
      get: <T>(): Promise<T> => {
        called = true;
        return Promise.resolve({ items: [] } as unknown as T);
      },
    };
    const id = await resolveApp(
      client as never,
      "tenant-1",
      "00000000-0000-0000-0000-000000000002",
    );
    expect(id).toBe("00000000-0000-0000-0000-000000000002");
    expect(called).toBe(false);
  });

  test("cache miss triggers fetch, unwraps res.items, resolves, and writes the slice", async () => {
    resetCache([]);
    const client = fakeAppClient([
      { id: "app-1", slug: "my-api", name: "My API" },
      { id: "app-2", slug: "my-frontend", name: "My Frontend" },
    ]);
    const id = await resolveApp(client as never, "t1", "my-api");
    expect(id).toBe("app-1");
    // Verify that the cache was written with the entries derived from res.items.
    const written = getSlice("apps");
    expect(written.length).toBe(2);
    const entry = written.find((e) => e.value === "my-api");
    expect(entry).toBeDefined();
    expect(entry?.id).toBe("app-1");
  });

  test("unknown app identifier throws with exitCode 5", async () => {
    resetCache([]);
    const client = fakeAppClient([
      { id: "app-1", slug: "my-api", name: "My API" },
    ]);
    let threw = false;
    try {
      await resolveApp(client as never, "t1", "does-not-exist");
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/not found/);
      expect((err as Error & { exitCode: number }).exitCode).toBe(5);
    }
    expect(threw).toBe(true);
  });
});

// ---------------------------------------------------------------------------

import type { HttpClient } from "../../../src/client/http";

function fakeRepoClient(handler: (path: string) => unknown): HttpClient {
  return {
    get: <T>(path: string) => Promise.resolve(handler(path) as T),
  } as unknown as HttpClient;
}

const TID = "tenant-1";

describe("resolveRepo", () => {
  test("bare UUID round-trips unchanged", async () => {
    const c = fakeRepoClient(() => {
      throw new Error("should not call API for UUID inputs");
    });
    const out = await resolveRepo(c, TID, "11111111-2222-3333-4444-555555555555");
    expect(out).toBe("11111111-2222-3333-4444-555555555555");
  });

  test("slug resolves via paginated repositories endpoint", async () => {
    const c = fakeRepoClient((path) => {
      expect(path).toContain(`/tenants/${TID}/repositories`);
      return {
        items: [
          { id: "repo-1", full_name: "acme/web", name: "web", owner_login: "acme" },
          { id: "repo-2", full_name: "acme/api", name: "api", owner_login: "acme" },
        ],
      };
    });
    const out = await resolveRepo(c, TID, "acme/api");
    expect(out).toBe("repo-2");
  });

  test("missing slug throws with exitCode 5", async () => {
    const c = fakeRepoClient(() => ({ items: [] }));
    const err = await resolveRepo(c, TID, "acme/missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { exitCode: number }).exitCode).toBe(5);
    expect((err as Error).message).toContain("repo");
    expect((err as Error).message).toContain("acme/missing");
  });
});
