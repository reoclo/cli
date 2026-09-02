// Only covers the delete_container tool added alongside the volume tools
// (container-volume-delete-ops). The rest of runtime.ts (recreate/scale/
// list_tenant_containers/update_container_labels) predates the
// tests/unit/mcp/ harness convention and is not retrofitted here. Driven
// against the registration function with a recording fake server, like
// groups.test.ts / volumes.test.ts.
import { expect, test } from "bun:test";
import { z } from "zod";
import { registerRuntimeTools } from "../../../src/mcp/tools/runtime";
import type { McpRegistrationContext, OrgScope } from "../../../src/mcp/tools/context";

type Registered = {
  name: string;
  schema: Record<string, z.ZodType>;
  cb: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
};

function fakeServer(): { registry: Registered[]; server: unknown } {
  const registry: Registered[] = [];
  const server = {
    tool(name: string, ...rest: unknown[]) {
      const cb = rest[rest.length - 1] as Registered["cb"];
      const schema = (rest.find(
        (r) => r && typeof r === "object" && !Array.isArray(r) && typeof r !== "function",
      ) ?? {}) as Registered["schema"];
      registry.push({ name, schema, cb });
    },
  };
  return { registry, server };
}

const SID = "0f0e0d0c-0b0a-4a4b-8c8d-1e1f2a2b3c3d";

function harness(): { registry: Registered[]; dels: string[] } {
  const { registry, server } = fakeServer();
  const dels: string[] = [];
  const client = {
    get: () => Promise.resolve({}),
    post: () => Promise.resolve({}),
    put: () => Promise.resolve({}),
    patch: () => Promise.resolve({}),
    del: (path: string) => {
      dels.push(path);
      return Promise.resolve({ success: true });
    },
  } as unknown as McpRegistrationContext["client"];
  const ctx: McpRegistrationContext = {
    client,
    orgParam: { organization: z.string().min(1) },
    resolveOrg: (): Promise<OrgScope> => Promise.resolve({ tenantId: "T-ACME", client }),
  };
  registerRuntimeTools(server as never, ctx);
  return { registry, dels };
}

function tool(registry: Registered[], name: string): Registered {
  const found = registry.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

test("registers delete_container with organization in its schema", () => {
  const { registry } = harness();
  const names = registry.map((t) => t.name);
  expect(names).toContain("delete_container");
  expect(Object.keys(tool(registry, "delete_container").schema)).toContain("organization");
});

test("delete_container issues a plain DELETE when remove_volumes is unset", async () => {
  const { registry, dels } = harness();
  await tool(registry, "delete_container").cb({
    organization: "acme",
    server_id: SID,
    container_name: "web-1",
  });
  expect(dels).toEqual([`/tenants/T-ACME/runtime/servers/${SID}/containers/web-1`]);
});

test("delete_container appends ?remove_volumes=true when set", async () => {
  const { registry, dels } = harness();
  await tool(registry, "delete_container").cb({
    organization: "acme",
    server_id: SID,
    container_name: "web-1",
    remove_volumes: true,
  });
  expect(dels).toEqual([`/tenants/T-ACME/runtime/servers/${SID}/containers/web-1?remove_volumes=true`]);
});

test("delete_container never sends an explicit remove_volumes=false", async () => {
  const { registry, dels } = harness();
  await tool(registry, "delete_container").cb({
    organization: "acme",
    server_id: SID,
    container_name: "web-1",
    remove_volumes: false,
  });
  expect(dels[0]).not.toContain("remove_volumes");
});
