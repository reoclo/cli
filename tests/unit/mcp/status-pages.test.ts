// create_status_page and update_status_page forward `theme` as branding.theme.
// The API merges a partial branding object, so only the theme is sent. Driven
// against the registration function with a recording fake server, like
// domains.test.ts.
import { expect, test } from "bun:test";
import { z } from "zod";
import { registerStatusPageTools } from "../../../src/mcp/tools/status-pages";
import type { McpRegistrationContext, OrgScope } from "../../../src/mcp/tools/context";

type Registered = {
  name: string;
  schema: Record<string, z.ZodType>;
  cb: (args: Record<string, unknown>) => Promise<unknown>;
};

type Call = { method: "post" | "patch"; path: string; body: unknown };

function harness(): { registry: Registered[]; calls: Call[] } {
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
  const calls: Call[] = [];
  const record =
    (method: Call["method"]) =>
    (path: string, body: unknown): Promise<unknown> => {
      calls.push({ method, path, body });
      return Promise.resolve({ id: "SP1" });
    };
  const client = {
    get: () => Promise.resolve({}),
    post: record("post"),
    put: () => Promise.resolve({}),
    patch: record("patch"),
    del: () => Promise.resolve({}),
  } as unknown as McpRegistrationContext["client"];
  const ctx: McpRegistrationContext = {
    client,
    orgParam: { organization: z.string().min(1) },
    resolveOrg: (): Promise<OrgScope> => Promise.resolve({ tenantId: "T-ACME", client }),
  };
  registerStatusPageTools(server as never, ctx);
  return { registry, calls };
}

function tool(registry: Registered[], name: string): Registered {
  const found = registry.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

test("create_status_page forwards theme as branding.theme", async () => {
  const { registry, calls } = harness();
  await tool(registry, "create_status_page").cb({
    organization: "acme",
    title: "Status",
    theme: "dark",
  });
  expect(calls).toEqual([
    {
      method: "post",
      path: "/tenants/T-ACME/status-pages/",
      body: { title: "Status", branding: { theme: "dark" } },
    },
  ]);
});

test("update_status_page forwards only the theme when that is all that changes", async () => {
  const { registry, calls } = harness();
  await tool(registry, "update_status_page").cb({
    organization: "acme",
    status_page_id: "SP1",
    theme: "survey_sheet",
  });
  expect(calls).toEqual([
    {
      method: "patch",
      path: "/tenants/T-ACME/status-pages/SP1",
      body: { branding: { theme: "survey_sheet" } },
    },
  ]);
});

test("without a theme neither tool sends branding", async () => {
  const { registry, calls } = harness();
  await tool(registry, "create_status_page").cb({ organization: "acme", title: "Status" });
  await tool(registry, "update_status_page").cb({
    organization: "acme",
    status_page_id: "SP1",
    title: "Renamed",
  });
  expect(calls.map((c) => c.body)).toEqual([{ title: "Status" }, { title: "Renamed" }]);
});

test("theme is an optional enum of the four themes on both tools", () => {
  const { registry } = harness();
  for (const name of ["create_status_page", "update_status_page"]) {
    const theme = tool(registry, name).schema.theme;
    expect(theme?.isOptional(), `${name} theme must be optional`).toBe(true);
    for (const ok of ["light", "dark", "system", "survey_sheet"]) {
      expect(theme?.safeParse(ok).success, `${name} accepts ${ok}`).toBe(true);
    }
    expect(theme?.safeParse("neon").success).toBe(false);
  }
});
