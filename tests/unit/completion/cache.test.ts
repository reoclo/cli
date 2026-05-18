import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getEnvKeys,
  getSlice,
  sliceAge,
  writeAllSlices,
  writeEnvKeys,
  writeSlice,
} from "../../../src/completion/cache";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reoclo-cache-"));
  process.env.REOCLO_CACHE_DIR = tmp;
});
afterEach(() => {
  delete process.env.REOCLO_CACHE_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

describe("completion cache", () => {
  test("round-trips a resource slice", () => {
    writeSlice("servers", [{ id: "1", value: "web", name: "Web", desc: "Web — ACTIVE" }]);
    expect(getSlice("servers")).toEqual([
      { id: "1", value: "web", name: "Web", desc: "Web — ACTIVE" },
    ]);
  });

  test("empty/cold slice returns [] and Infinity age", () => {
    expect(getSlice("apps")).toEqual([]);
    expect(sliceAge("apps")).toBe(Infinity);
  });

  test("sliceAge is small right after a write", () => {
    writeSlice("apps", []);
    expect(sliceAge("apps")).toBeLessThan(1000);
  });

  test("writeAllSlices replaces every provided slice", () => {
    writeAllSlices({ servers: [{ id: "s", value: "s", name: "s", desc: "" }], apps: [] });
    expect(getSlice("servers")).toHaveLength(1);
    expect(getSlice("apps")).toEqual([]);
  });

  test("per-app env keys round-trip", () => {
    writeEnvKeys("app-1", ["DATABASE_URL", "PORT"]);
    expect(getEnvKeys("app-1")).toEqual(["DATABASE_URL", "PORT"]);
    expect(getEnvKeys("app-2")).toEqual([]);
  });

  test("a corrupt cache file is treated as empty", () => {
    writeFileSync(join(tmp, "completion-cache.json"), "{ not json", "utf8");
    expect(getSlice("servers")).toEqual([]);
  });

  test("a wrong-version cache file is discarded", () => {
    writeFileSync(join(tmp, "completion-cache.json"), JSON.stringify({ version: 1 }), "utf8");
    expect(getSlice("servers")).toEqual([]);
  });
});
