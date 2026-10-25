import { expect, test } from "bun:test";
import { z } from "zod";
import { registerBuildTools } from "../../../src/mcp/tools/builds";
import type { McpRegistrationContext, OrgScope } from "../../../src/mcp/tools/context";

type Registered = { name: string; cb: (args: Record<string, unknown>) => Promise<unknown> };

function harness(): { registry: Registered[]; gets: string[] } {
  const registry: Registered[] = [];
  const server = {
    tool(name: string, ...rest: unknown[]) {
      registry.push({ name, cb: rest[rest.length - 1] as Registered["cb"] });
    },
  };
  const gets: string[] = [];
  const client = {
    get: (path: string) => {
      gets.push(path);
      return Promise.resolve({});
    },
  } as unknown as McpRegistrationContext["client"];
  const ctx: McpRegistrationContext = {
    client,
    orgParam: { organization: z.string().min(1) },
    resolveOrg: (): Promise<OrgScope> => Promise.resolve({ tenantId: "T-ACME", client }),
  };
  registerBuildTools(server as never, ctx);
  return { registry, gets };
}

function tool(registry: Registered[], name: string): Registered {
  const found = registry.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

test("build tools are read-only: nothing that creates, changes, deletes or cancels", () => {
  const { registry } = harness();
  expect(registry.map((t) => t.name).sort()).toEqual([
    "get_build",
    "get_build_logs",
    "get_build_pool",
    "list_build_pools",
    "list_builds",
  ]);
});

test("list_builds filters by application and pool and limits the page", async () => {
  const { registry, gets } = harness();
  await tool(registry, "list_builds").cb({ organization: "acme", application_id: "A1", pool_id: "P1", limit: 5 });
  await tool(registry, "list_builds").cb({ organization: "acme" });
  expect(gets).toEqual([
    "/tenants/T-ACME/builds/?application_id=A1&pool_id=P1&limit=5",
    "/tenants/T-ACME/builds/",
  ]);
});

test("get_build, get_build_logs, get_build_pool and list_build_pools hit their routes", async () => {
  const { registry, gets } = harness();
  await tool(registry, "get_build").cb({ organization: "acme", build_id: "B1" });
  await tool(registry, "get_build_logs").cb({ organization: "acme", build_id: "B1" });
  await tool(registry, "get_build_pool").cb({ organization: "acme", pool_id: "P1" });
  await tool(registry, "list_build_pools").cb({ organization: "acme", limit: 10 });
  expect(gets).toEqual([
    "/tenants/T-ACME/builds/B1",
    "/tenants/T-ACME/builds/B1/logs",
    "/tenants/T-ACME/build-pools/P1",
    "/tenants/T-ACME/build-pools/?limit=10",
  ]);
});
