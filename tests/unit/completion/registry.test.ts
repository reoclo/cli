import { describe, expect, test } from "bun:test";
import { RESOURCE_REGISTRY } from "../../../src/completion/registry";

describe("RESOURCE_REGISTRY", () => {
  test("has a definition for every index kind", () => {
    for (const kind of ["servers", "apps", "deployments", "domains", "tunnels"]) {
      expect(RESOURCE_REGISTRY[kind as keyof typeof RESOURCE_REGISTRY]).toBeDefined();
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
});
