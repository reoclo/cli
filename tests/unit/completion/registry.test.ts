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
});
