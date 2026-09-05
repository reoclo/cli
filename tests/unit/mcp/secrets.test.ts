// Secret project tools are metadata-only: list + rename/describe. Driven
// against the registration function with a recording fake, like volumes.test.ts.
import { expect, test } from "bun:test";
import { z } from "zod";
import { registerSecretProjectTools } from "../../../src/mcp/tools/secrets";
import type { McpRegistrationContext, OrgScope } from "../../../src/mcp/tools/context";

type Registered = {
  name: string;
  schema: Record<string, z.ZodType>;
  cb: (args: Record<string, unknown>) => Promise<unknown>;
};

const PID = "019ff244-6f63-7ff0-b1a2-72b9e5ab8c29";

function harness(): {
  registry: Registered[];
  gets: string[];
  patches: { path: string; body: unknown }[];
} {
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
  const gets: string[] = [];
  const patches: { path: string; body: unknown }[] = [];
  const client = {
    get: (path: string) => {
      gets.push(path);
      return Promise.resolve([{ id: PID, name: "prod", description: null, secret_count: 3 }]);
    },
    post: () => Promise.resolve({}),
    put: () => Promise.resolve({}),
    patch: (path: string, body: unknown) => {
      patches.push({ path, body });
      return Promise.resolve({ id: PID, name: "renamed" });
    },
    del: () => Promise.resolve({}),
  } as unknown as McpRegistrationContext["client"];
  const ctx: McpRegistrationContext = {
    client,
    orgParam: { organization: z.string().min(1) },
    resolveOrg: (): Promise<OrgScope> => Promise.resolve({ tenantId: "T-ACME", client }),
  };
  registerSecretProjectTools(server as never, ctx);
  return { registry, gets, patches };
}

function tool(registry: Registered[], name: string): Registered {
  const found = registry.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

test("registers list + update with organization in every schema, and nothing that reads values", () => {
  const { registry } = harness();
  expect(registry.map((t) => t.name).sort()).toEqual(
    ["list_secret_projects", "update_secret_project"].sort(),
  );
  for (const t of registry) {
    expect(Object.keys(t.schema), `${t.name} must expose organization`).toContain("organization");
  }
});

test("list_secret_projects reads the tenant's project collection", async () => {
  const { registry, gets } = harness();
  const res = (await tool(registry, "list_secret_projects").cb({ organization: "acme" })) as {
    content: Array<{ text: string }>;
  };
  expect(gets).toEqual(["/tenants/T-ACME/secret-projects"]);
  expect(res.content[0]?.text).toContain("prod");
});

test("update_secret_project patches only the fields given", async () => {
  const { registry, patches } = harness();
  await tool(registry, "update_secret_project").cb({
    organization: "acme",
    project_id: PID,
    name: "payments-production",
  });
  expect(patches).toEqual([
    { path: `/tenants/T-ACME/secret-projects/${PID}`, body: { name: "payments-production" } },
  ]);

  patches.length = 0;
  await tool(registry, "update_secret_project").cb({
    organization: "acme",
    project_id: PID,
    description: "Stripe + Postgres for prod",
  });
  expect(patches).toEqual([
    {
      path: `/tenants/T-ACME/secret-projects/${PID}`,
      body: { description: "Stripe + Postgres for prod" },
    },
  ]);
});

test("update_secret_project maps an empty description to null (clear)", async () => {
  const { registry, patches } = harness();
  await tool(registry, "update_secret_project").cb({
    organization: "acme",
    project_id: PID,
    description: "",
  });
  expect(patches[0]?.body).toEqual({ description: null });
});

test("update_secret_project refuses a no-op instead of sending an empty PATCH", async () => {
  const { registry, patches } = harness();
  const res = (await tool(registry, "update_secret_project").cb({
    organization: "acme",
    project_id: PID,
  })) as { isError?: boolean; content: Array<{ text: string }> };
  expect(res.isError).toBe(true);
  expect(res.content[0]?.text).toContain("nothing to update");
  expect(patches).toEqual([]);
});

test("update_secret_project schema requires a UUID id and a non-blank name", () => {
  const { registry } = harness();
  const { schema } = tool(registry, "update_secret_project");
  expect(schema["project_id"]!.safeParse("prod").success).toBe(false);
  expect(schema["project_id"]!.safeParse(PID).success).toBe(true);
  expect(schema["name"]!.safeParse("   ").success).toBe(false);
  expect(schema["name"]!.safeParse("ok").success).toBe(true);
});
