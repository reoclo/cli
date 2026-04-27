import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveServer } from "../../../src/client/resolve";

interface CacheEntry {
  id: string;
  slug: string;
  name: string | null;
  ts: number;
}
interface CacheFile {
  version: number;
  servers: Record<string, CacheEntry>;
  apps: Record<string, CacheEntry>;
}

const fakeClient = (servers: Array<Record<string, unknown>>) => ({
  get: <T>(_path: string): Promise<T> => Promise.resolve(servers as unknown as T),
});

describe("resolveServer", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "reoclo-cache-"));
    process.env.REOCLO_CACHE_DIR = cacheDir;
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

  test("slug input matches against API list and caches result", async () => {
    const client = fakeClient([
      { id: "srv-1", slug: "reoclo-production", name: "Reoclo Production" },
      { id: "srv-2", slug: "prawnwire-mail", name: "Prawnwire Mail" },
    ]);
    const id = await resolveServer(client as never, "t1", "reoclo-production");
    expect(id).toBe("srv-1");

    const cache = JSON.parse(readFileSync(join(cacheDir, "slug-cache.json"), "utf8")) as CacheFile;
    expect(cache.servers["reoclo-production"]).toMatchObject({
      id: "srv-1",
      slug: "reoclo-production",
      name: "Reoclo Production",
    });
  });

  test("name input falls back when slug doesn't match", async () => {
    const client = fakeClient([
      { id: "srv-1", slug: "reoclo-production", name: "Reoclo Production" },
    ]);
    const id = await resolveServer(client as never, "t1", "Reoclo Production");
    expect(id).toBe("srv-1");
  });

  test("unknown identifier throws NotFoundError", async () => {
    const client = fakeClient([
      { id: "srv-1", slug: "reoclo-production", name: "Reoclo Production" },
    ]);
    let threw = false;
    try {
      await resolveServer(client as never, "t1", "nope");
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/not found/);
    }
    expect(threw).toBe(true);
  });

  test("cache file with old shape (v1) is rebuilt on read", async () => {
    const oldShape = {
      version: 1,
      servers: { "Reoclo Production": { id: "srv-1", ts: Date.now() } },
      apps: {},
    };
    writeFileSync(join(cacheDir, "slug-cache.json"), JSON.stringify(oldShape));

    const client = fakeClient([
      { id: "srv-1", slug: "reoclo-production", name: "Reoclo Production" },
    ]);
    const id = await resolveServer(client as never, "t1", "reoclo-production");
    expect(id).toBe("srv-1");

    const cache = JSON.parse(readFileSync(join(cacheDir, "slug-cache.json"), "utf8")) as CacheFile;
    expect(cache.version).toBe(2);
    expect(cache.servers["reoclo-production"]!.slug).toBe("reoclo-production");
  });
});
