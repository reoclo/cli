import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCachedServers } from "../../../src/completion/resources";

describe("getCachedServers", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "reoclo-comp-"));
    process.env.REOCLO_CACHE_DIR = cacheDir;
  });

  test("returns slug keys (not name keys)", () => {
    writeFileSync(
      join(cacheDir, "slug-cache.json"),
      JSON.stringify({
        version: 2,
        servers: {
          "reoclo-production": { id: "s1", slug: "reoclo-production", name: "Reoclo Production", ts: Date.now() },
          "prawnwire-mail":    { id: "s2", slug: "prawnwire-mail",    name: "Prawnwire Mail",    ts: Date.now() },
        },
        apps: {},
      }),
    );
    const servers = getCachedServers();
    expect(servers.sort()).toEqual(["prawnwire-mail", "reoclo-production"]);
  });

  test("returns empty array when cache file is missing", () => {
    expect(getCachedServers()).toEqual([]);
  });

  test("returns empty array when cache version is stale (v1)", () => {
    writeFileSync(
      join(cacheDir, "slug-cache.json"),
      JSON.stringify({ version: 1, servers: { "Old Name": { id: "s1", ts: Date.now() } } }),
    );
    expect(getCachedServers()).toEqual([]);
  });
});
