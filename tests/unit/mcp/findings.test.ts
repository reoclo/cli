import { expect, test } from "bun:test";
import { z } from "zod";
import { registerFindingTools } from "../../../src/mcp/tools/findings";
import type { McpRegistrationContext, OrgScope } from "../../../src/mcp/tools/context";

type Registered = {
  name: string;
  schema: Record<string, z.ZodType>;
  cb: (args: Record<string, unknown>) => Promise<unknown>;
};

function harness(): { registry: Registered[]; gets: string[] } {
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
  const client = {
    get: (path: string) => {
      gets.push(path);
      return Promise.resolve({ items: [], page: 1, page_size: 50, total: 0 });
    },
  } as unknown as McpRegistrationContext["client"];
  const ctx: McpRegistrationContext = {
    client,
    orgParam: { organization: z.string().min(1) },
    resolveOrg: (): Promise<OrgScope> => Promise.resolve({ tenantId: "T-ACME", client }),
  };
  registerFindingTools(server as never, ctx);
  return { registry, gets };
}

function tool(registry: Registered[], name: string): Registered {
  const found = registry.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

test("registers list_findings and get_finding, each taking organization", () => {
  const { registry } = harness();
  expect(registry.map((t) => t.name).sort()).toEqual(["get_finding", "list_findings"]);
  for (const t of registry) {
    expect(Object.keys(t.schema), `${t.name} must expose organization`).toContain("organization");
  }
});

test("list_findings asks for open findings unless told otherwise", async () => {
  const { registry, gets } = harness();
  await tool(registry, "list_findings").cb({ organization: "acme" });
  await tool(registry, "list_findings").cb({
    organization: "acme",
    status: "all",
    severity: "high",
    server_id: "S1",
    limit: 5,
  });
  expect(gets).toEqual([
    "/tenants/T-ACME/log-watcher/findings?status=open",
    "/tenants/T-ACME/log-watcher/findings?severity=high&server_id=S1&page_size=5",
  ]);
});

test("get_finding reads one finding", async () => {
  const { registry, gets } = harness();
  await tool(registry, "get_finding").cb({ organization: "acme", finding_id: "F1" });
  expect(gets).toEqual(["/tenants/T-ACME/log-watcher/findings/F1"]);
});
