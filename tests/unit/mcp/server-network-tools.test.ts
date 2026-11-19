import { expect, test } from "bun:test";
import { z } from "zod";
import { registerServerTools } from "../../../src/mcp/tools/servers";
import { ApiError } from "../../../src/client/errors";
import type { McpRegistrationContext, OrgScope } from "../../../src/mcp/tools/context";

type Result = { content: Array<{ text: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const ACCESS = {
  mode: "tunnels_only",
  status: "enforced",
  services: [
    { port: 5432, protocol: "tcp", bind_address: "127.0.0.1", process: "postgres" },
    { port: 5432, protocol: "tcp", bind_address: "::1", process: "postgres" },
  ],
};

function harness(opts: { putError?: Error } = {}): {
  tool: (name: string) => Handler;
  puts: Array<{ path: string; body: unknown }>;
  posts: Array<{ path: string; body: unknown }>;
} {
  const handlers = new Map<string, Handler>();
  const server = {
    tool(name: string, ...rest: unknown[]) {
      handlers.set(name, rest[rest.length - 1] as Handler);
    },
  };
  const puts: Array<{ path: string; body: unknown }> = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  const client = {
    get: (path: string) =>
      Promise.resolve(path.endsWith("/network-access") ? ACCESS : { slug: "web-1" }),
    put: (path: string, body: unknown) => {
      puts.push({ path, body });
      return opts.putError ? Promise.reject(opts.putError) : Promise.resolve({ ...ACCESS, status: "applying" });
    },
    post: (path: string, body: unknown) => {
      posts.push({ path, body });
      return Promise.resolve({
        token: { id: "tok-1", expires_at: "2026-01-01T01:00:00Z" },
        plaintext_token: "rt_secret",
        runner_gateway_url: null,
        runner_install_url: "https://get.example.test/",
      });
    },
  } as unknown as McpRegistrationContext["client"];
  const ctx: McpRegistrationContext = {
    client,
    orgParam: { organization: z.string().min(1) },
    resolveOrg: (): Promise<OrgScope> => Promise.resolve({ tenantId: "T1", client }),
  };
  registerServerTools(server as never, ctx);
  return {
    tool: (name) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`${name} not registered`);
      return handler;
    },
    puts,
    posts,
  };
}

const parsed = (r: Result): Record<string, unknown> =>
  JSON.parse(r.content[0]?.text ?? "{}") as Record<string, unknown>;

test("get_server_network_access returns the API shape plus one tunnel command per service", async () => {
  const r = await harness().tool("get_server_network_access")({ organization: "acme", server_id: "S1" });

  expect(parsed(r)["status"]).toBe("enforced");
  expect(parsed(r)["tunnel_commands"]).toEqual([
    { port: 5432, protocol: "tcp", process: "postgres", command: "reoclo tunnel S1 -L 5432:5432" },
  ]);
});

test("set_server_network_access puts the mode only when confirm_slug matches", async () => {
  const h = harness();
  const refused = await h.tool("set_server_network_access")({
    organization: "acme",
    server_id: "S1",
    mode: "tunnels_only",
    confirm_slug: "web-2",
  });
  expect(refused.isError).toBe(true);
  expect(h.puts).toEqual([]);

  const r = await h.tool("set_server_network_access")({
    organization: "acme",
    server_id: "S1",
    mode: "tunnels_only",
    confirm_slug: "web-1",
  });
  expect(parsed(r)["status"]).toBe("applying");
  expect(h.puts).toEqual([{ path: "/tenants/T1/servers/S1/network-access", body: { mode: "tunnels_only" } }]);
});

test("set_server_network_access returns the API's refusal as a tool error", async () => {
  const detail = JSON.stringify({ code: "network_access_blocked", blockers: [{ kind: "domain", label: "app.example.com" }] });
  const h = harness({ putError: new ApiError(409, detail, "/network-access") });
  const r = await h.tool("set_server_network_access")({
    organization: "acme",
    server_id: "S1",
    mode: "tunnels_only",
    confirm_slug: "web-1",
  });

  expect(r.isError).toBe(true);
  expect(parsed(r)["status"]).toBe(409);
  expect(parsed(r)["message"]).toContain("app.example.com");
});

test("reapply_server_network_access posts to the reapply route", async () => {
  const h = harness();
  await h.tool("reapply_server_network_access")({ organization: "acme", server_id: "S1" });

  expect(h.posts.map((p) => p.path)).toEqual(["/tenants/T1/servers/S1/network-access/reapply"]);
});

test("create_server_setup_script with tunnels_only asks for a tunnels-only token and drops the port flags", async () => {
  const h = harness();
  const r = await h.tool("create_server_setup_script")({
    organization: "acme",
    name: "web-2",
    tunnels_only: true,
    firewall_allow: ["8080"],
    trusted_ips: ["203.0.113.7"],
  });
  const script = parsed(r)["script"] as string;

  expect(h.posts[0]?.path).toBe("/admin/runners/tokens?tenant_id=T1&network_access=tunnels_only");
  expect(script).toContain("--tunnels-only");
  expect(script).not.toContain("--firewall-allow");
  expect(script).not.toContain("--fail2ban-ignore");
});
