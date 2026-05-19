import { describe, expect, test } from "bun:test";
import { RESOURCE_REGISTRY } from "../../../src/completion/registry";
import { INDEX_KINDS } from "../../../src/completion/types";

describe("RESOURCE_REGISTRY", () => {
  test("has a definition for every index kind", () => {
    for (const kind of INDEX_KINDS) {
      expect(RESOURCE_REGISTRY[kind]).toBeDefined();
    }
  });

  test("server toEntry maps an API object to an Entry", () => {
    const entry = RESOURCE_REGISTRY.servers.toEntry({
      id: "srv-1",
      slug: "prod-web",
      name: "Prod Web",
      status: "ACTIVE",
    });
    expect(entry).toEqual({
      id: "srv-1",
      value: "prod-web",
      name: "Prod Web",
      desc: "Prod Web — ACTIVE",
    });
  });

  test("deployment toEntry uses the id as the completion value", () => {
    const entry = RESOURCE_REGISTRY.deployments.toEntry({ id: "dep-1", status: "success" });
    expect(entry.value).toBe("dep-1");
  });

  test("toEntry mappers cover all five kinds including str() fallback paths", () => {
    // apps — slug and name both present
    expect(
      RESOURCE_REGISTRY.apps.toEntry({ id: "a1", slug: "api", name: "API" }),
    ).toEqual({ id: "a1", value: "api", name: "API", desc: "API" });

    // domains — fqdn and status present
    expect(
      RESOURCE_REGISTRY.domains.toEntry({ id: "d1", fqdn: "x.com", status: "verified" }),
    ).toEqual({ id: "d1", value: "x.com", name: "x.com", desc: "x.com — verified" });

    // tunnels — mode present, id used as value/name
    expect(
      RESOURCE_REGISTRY.tunnels.toEntry({ id: "t1", mode: "forward" }),
    ).toEqual({ id: "t1", value: "t1", name: "t1", desc: "forward" });

    // servers fallback — slug and name absent, status absent
    expect(
      RESOURCE_REGISTRY.servers.toEntry({ id: "x" }),
    ).toEqual({ id: "x", value: "x", name: "x", desc: "x — " });
  });

  test("monitors toEntry maps id/name/status", () => {
    const e = RESOURCE_REGISTRY.monitors.toEntry({ id: "m1", name: "API", status: "active" });
    expect(e).toEqual({ id: "m1", value: "m1", name: "API", desc: "API — active" });
  });

  test("status-pages toEntry maps id/title", () => {
    const e = RESOURCE_REGISTRY["status-pages"].toEntry({ id: "sp1", title: "Public" });
    expect(e).toEqual({ id: "sp1", value: "sp1", name: "Public", desc: "Public" });
  });

  test("incidents toEntry maps id/title/severity/state", () => {
    const e = RESOURCE_REGISTRY.incidents.toEntry({
      id: "i1", title: "Outage", severity: "major", state: "investigating",
    });
    expect(e).toEqual({ id: "i1", value: "i1", name: "Outage", desc: "major/investigating" });
  });

  test("monitors toEntry falls back when name/status absent", () => {
    const e = RESOURCE_REGISTRY.monitors.toEntry({ id: "m1" });
    expect(e).toEqual({ id: "m1", value: "m1", name: "m1", desc: "m1 — " });
  });

  test("status-pages toEntry falls back when title absent", () => {
    const e = RESOURCE_REGISTRY["status-pages"].toEntry({ id: "sp1" });
    expect(e).toEqual({ id: "sp1", value: "sp1", name: "sp1", desc: "sp1" });
  });

  test("incidents toEntry falls back when title/severity/state absent", () => {
    const e = RESOURCE_REGISTRY.incidents.toEntry({ id: "i1" });
    expect(e).toEqual({ id: "i1", value: "i1", name: "i1", desc: "" });
  });

  test("schedule toEntry maps id/name/status", () => {
    const e = RESOURCE_REGISTRY.schedule.toEntry({
      id: "so1", name: "nightly-restart", status: "ACTIVE",
    });
    expect(e).toEqual({
      id: "so1", value: "so1", name: "nightly-restart", desc: "nightly-restart — ACTIVE",
    });
  });

  test("schedule toEntry falls back when name/status absent", () => {
    const e = RESOURCE_REGISTRY.schedule.toEntry({ id: "so1" });
    expect(e).toEqual({ id: "so1", value: "so1", name: "so1", desc: "so1 — " });
  });
});

describe("repos ResourceDef", () => {
  test('INDEX_KINDS contains "repos"', () => {
    expect(INDEX_KINDS).toContain("repos");
  });

  test("RESOURCE_REGISTRY.repos maps a raw repo doc to an Entry", () => {
    const def = RESOURCE_REGISTRY.repos;
    expect(def).toBeDefined();
    expect(def.kind).toBe("repos");
    expect(def.indexField).toBe("repos");
    const entry = def.toEntry({
      id: "abc",
      full_name: "acme/web",
      name: "web",
      owner_login: "acme",
      default_branch: "main",
      is_private: false,
    });
    expect(entry.id).toBe("abc");
    expect(entry.value).toBe("acme/web");
    expect(entry.name).toBe("acme/web");
    expect(entry.desc).toContain("main");
    expect(entry.desc).toContain("public");
  });

  test("private repo desc says 'private'", () => {
    const entry = RESOURCE_REGISTRY.repos.toEntry({
      id: "abc",
      full_name: "acme/web",
      default_branch: "main",
      is_private: true,
    });
    expect(entry.desc).toContain("private");
  });
});
