// Volume tools drive the container-volume-delete-ops backend (api 1.219.0+).
// Driven against the registration function with a recording fake server,
// like groups.test.ts / domains.test.ts.
import { expect, test } from "bun:test";
import { z } from "zod";
import { registerVolumeTools } from "../../../src/mcp/tools/volumes";
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

function harness(): {
  registry: Registered[];
  gets: string[];
  posts: { path: string; body: unknown }[];
  dels: string[];
} {
  const { registry, server } = fakeServer();
  const gets: string[] = [];
  const posts: { path: string; body: unknown }[] = [];
  const dels: string[] = [];
  const client = {
    get: (path: string) => {
      gets.push(path);
      return Promise.resolve({ volumes: [], partial_error: null });
    },
    post: (path: string, body?: unknown) => {
      posts.push({ path, body });
      return Promise.resolve({ success: true });
    },
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
  registerVolumeTools(server as never, ctx);
  return { registry, gets, posts, dels };
}

function tool(registry: Registered[], name: string): Registered {
  const found = registry.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

test("registers the volume tool family with organization in every schema", () => {
  const { registry } = harness();
  const names = registry.map((t) => t.name);
  expect(names.sort()).toEqual(
    ["create_volume", "delete_volume", "list_volumes", "prune_volumes"].sort(),
  );
  for (const t of registry) {
    expect(Object.keys(t.schema), `${t.name} must expose organization`).toContain("organization");
  }
});

test("list_volumes reads the server's volumes collection", async () => {
  const { registry, gets } = harness();
  await tool(registry, "list_volumes").cb({ organization: "acme", server_id: SID });
  expect(gets).toEqual([`/tenants/T-ACME/runtime/servers/${SID}/volumes`]);
});

test("create_volume posts name/driver/labels, omitting unset optionals", async () => {
  const { registry, posts } = harness();
  await tool(registry, "create_volume").cb({
    organization: "acme",
    server_id: SID,
    name: "pgdata",
  });
  expect(posts).toEqual([
    { path: `/tenants/T-ACME/runtime/servers/${SID}/volumes`, body: { name: "pgdata" } },
  ]);

  posts.length = 0;
  await tool(registry, "create_volume").cb({
    organization: "acme",
    server_id: SID,
    name: "pgdata",
    driver: "local",
    labels: { team: "platform" },
  });
  expect(posts).toEqual([
    {
      path: `/tenants/T-ACME/runtime/servers/${SID}/volumes`,
      body: { name: "pgdata", driver: "local", labels: { team: "platform" } },
    },
  ]);
});

test("delete_volume issues a DELETE against the named volume", async () => {
  const { registry, dels } = harness();
  await tool(registry, "delete_volume").cb({ organization: "acme", server_id: SID, name: "pgdata" });
  expect(dels).toEqual([`/tenants/T-ACME/runtime/servers/${SID}/volumes/pgdata`]);
});

test("prune_volumes posts to the prune endpoint", async () => {
  const { registry, posts } = harness();
  await tool(registry, "prune_volumes").cb({ organization: "acme", server_id: SID });
  expect(posts).toEqual([
    { path: `/tenants/T-ACME/runtime/servers/${SID}/volumes/prune`, body: undefined },
  ]);
});
