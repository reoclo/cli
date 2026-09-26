// tests/unit/completion/cache-tenant.test.ts
//
// The completion cache is partitioned by <profile>/<org slug> so completions
// only ever reflect the org an invocation explicitly targets. With no org
// stamped there is no fallback to any profile's login org: reads and writes
// land in the no-org bucket, which stays empty for every real org.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearOrg,
  clearProfile,
  getSlice,
  setActiveOrg,
  writeSlice,
} from "../../../src/completion/cache";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reoclo-cache-tenant-"));
  process.env.REOCLO_CACHE_DIR = tmp;
  setActiveOrg(undefined, undefined);
});
afterEach(() => {
  delete process.env.REOCLO_CACHE_DIR;
  delete process.env.REOCLO_CONFIG_DIR;
  setActiveOrg(undefined, undefined);
  rmSync(tmp, { recursive: true, force: true });
});

const srv = (v: string) => ({ id: v, value: v, name: v, desc: "" });

describe("org-scoped completion cache", () => {
  test("slices written under one org are invisible to another", () => {
    setActiveOrg("default", "acme");
    writeSlice("servers", [srv("a-web")]);

    setActiveOrg("default", "beta");
    expect(getSlice("servers")).toEqual([]);

    setActiveOrg("default", "acme");
    expect(getSlice("servers").map((e) => e.value)).toEqual(["a-web"]);
  });

  test("the same slug under two profiles is two buckets (staging vs production)", () => {
    setActiveOrg("default", "platform");
    writeSlice("servers", [srv("prod-web")]);
    setActiveOrg("staging", "platform");
    expect(getSlice("servers")).toEqual([]);
    writeSlice("servers", [srv("stg-web")]);
    setActiveOrg("default", "platform");
    expect(getSlice("servers").map((e) => e.value)).toEqual(["prod-web"]);
  });

  test("clearOrg drops only the named org's slices", () => {
    setActiveOrg("default", "acme");
    writeSlice("servers", [srv("a-web")]);
    setActiveOrg("default", "beta");
    writeSlice("servers", [srv("b-web")]);

    clearOrg("default", "acme");

    setActiveOrg("default", "acme");
    expect(getSlice("servers")).toEqual([]);
    setActiveOrg("default", "beta");
    expect(getSlice("servers").map((e) => e.value)).toEqual(["b-web"]);
  });

  test("clearProfile drops every org bucket of that profile and no other", () => {
    setActiveOrg("default", "acme");
    writeSlice("servers", [srv("a-web")]);
    setActiveOrg("default", "beta");
    writeSlice("servers", [srv("b-web")]);
    setActiveOrg("staging", "acme");
    writeSlice("servers", [srv("s-web")]);

    clearProfile("default");

    setActiveOrg("default", "acme");
    expect(getSlice("servers")).toEqual([]);
    setActiveOrg("default", "beta");
    expect(getSlice("servers")).toEqual([]);
    setActiveOrg("staging", "acme");
    expect(getSlice("servers").map((e) => e.value)).toEqual(["s-web"]);
  });

  // The explicit-org policy on the cache path: with nothing stamped, a stored
  // profile's login org must NOT become the bucket. Before this, a write in an
  // unbound directory landed under the profile's tenant_id, so completions
  // there came from the login org.
  test("with no org stamped, writes never reach any org's bucket (no profile fallback)", () => {
    const cfgDir = mkdtempSync(join(tmpdir(), "reoclo-cfg-"));
    process.env.REOCLO_CONFIG_DIR = cfgDir;
    writeFileSync(
      join(cfgDir, "config.json"),
      JSON.stringify({
        active_profile: "default",
        profiles: { default: { tenant_id: "T-cfg", tenant_slug: "login-org", auth_kind: "oauth" } },
      }),
      "utf8",
    );
    try {
      writeSlice("servers", [srv("unbound-web")]);
      setActiveOrg("default", "login-org");
      expect(getSlice("servers")).toEqual([]);
      setActiveOrg(undefined, undefined);
      expect(getSlice("servers").map((e) => e.value)).toEqual(["unbound-web"]);
    } finally {
      rmSync(cfgDir, { recursive: true, force: true });
    }
  });

  test("a slug with no profile still buckets on its own", () => {
    setActiveOrg(undefined, "acme");
    writeSlice("servers", [srv("x")]);
    setActiveOrg("default", "acme");
    expect(getSlice("servers")).toEqual([]);
    setActiveOrg(undefined, "acme");
    expect(getSlice("servers").map((e) => e.value)).toEqual(["x"]);
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
    setActiveOrg("default", "any");
    expect(getSlice("servers")).toEqual([]);
  });

  test("a v4 (tenant-id keyed) cache file is discarded", () => {
    writeFileSync(
      join(tmp, "completion-cache.json"),
      JSON.stringify({
        version: 4,
        tenants: { "t-1": { resources: { servers: { ts: 1, entries: [srv("old")] } }, envKeys: {} } },
      }),
      "utf8",
    );
    setActiveOrg("default", "acme");
    expect(getSlice("servers")).toEqual([]);
  });
});
