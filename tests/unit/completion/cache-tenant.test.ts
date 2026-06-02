// tests/unit/completion/cache-tenant.test.ts
//
// The completion cache is partitioned by tenant_id so completions only ever
// reflect the currently-authorised account. These tests cover the isolation
// guarantees and the proactive clear used on identity change (login / org use).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearTenant,
  getSlice,
  setActiveTenantId,
  writeSlice,
} from "../../../src/completion/cache";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reoclo-cache-tenant-"));
  process.env.REOCLO_CACHE_DIR = tmp;
  setActiveTenantId(undefined);
});
afterEach(() => {
  delete process.env.REOCLO_CACHE_DIR;
  delete process.env.REOCLO_CONFIG_DIR;
  setActiveTenantId(undefined);
  rmSync(tmp, { recursive: true, force: true });
});

const srv = (v: string) => ({ id: v, value: v, name: v, desc: "" });

describe("tenant-scoped completion cache", () => {
  test("slices written under one tenant are invisible to another", () => {
    setActiveTenantId("tenant-A");
    writeSlice("servers", [srv("a-web")]);

    setActiveTenantId("tenant-B");
    expect(getSlice("servers")).toEqual([]);

    setActiveTenantId("tenant-A");
    expect(getSlice("servers").map((e) => e.value)).toEqual(["a-web"]);
  });

  test("clearTenant drops only the named tenant's slices", () => {
    setActiveTenantId("tenant-A");
    writeSlice("servers", [srv("a-web")]);
    setActiveTenantId("tenant-B");
    writeSlice("servers", [srv("b-web")]);

    clearTenant("tenant-A");

    setActiveTenantId("tenant-A");
    expect(getSlice("servers")).toEqual([]);
    setActiveTenantId("tenant-B");
    expect(getSlice("servers").map((e) => e.value)).toEqual(["b-web"]);
  });

  test("falls back to the active profile's tenant_id when no override is set", () => {
    const cfgDir = mkdtempSync(join(tmpdir(), "reoclo-cfg-"));
    process.env.REOCLO_CONFIG_DIR = cfgDir;
    writeFileSync(
      join(cfgDir, "config.json"),
      JSON.stringify({ active_profile: "default", profiles: { default: { tenant_id: "T-cfg" } } }),
      "utf8",
    );

    // No override set → cache resolves the tenant from config (T-cfg).
    writeSlice("servers", [srv("cfg-web")]);
    // The same bucket is reachable by stamping T-cfg explicitly.
    setActiveTenantId("T-cfg");
    expect(getSlice("servers").map((e) => e.value)).toEqual(["cfg-web"]);

    rmSync(cfgDir, { recursive: true, force: true });
  });

  test("a v3 (pre-partition) cache file is discarded", () => {
    writeFileSync(
      join(tmp, "completion-cache.json"),
      JSON.stringify({
        version: 3,
        resources: { servers: { ts: 1, entries: [srv("old")] } },
        envKeys: {},
      }),
      "utf8",
    );
    setActiveTenantId("any");
    expect(getSlice("servers")).toEqual([]);
  });
});
