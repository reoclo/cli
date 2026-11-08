import { expect, test } from "bun:test";
import { z } from "zod";
import { registerServerTools } from "../../../src/mcp/tools/servers";
import { ApiError } from "../../../src/client/errors";
import type { McpRegistrationContext, OrgScope } from "../../../src/mcp/tools/context";

type Result = { content: Array<{ text: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

function harness(opts: { portsError?: Error; slug?: string } = {}): {
  tool: (name: string) => Handler;
  posts: Array<{ path: string; body: unknown }>;
  deletes: string[];
} {
  const handlers = new Map<string, Handler>();
  const server = {
    tool(name: string, ...rest: unknown[]) {
      handlers.set(name, rest[rest.length - 1] as Handler);
    },
  };
  const posts: Array<{ path: string; body: unknown }> = [];
  const deletes: string[] = [];
  const client = {
    get: (path: string) => {
      if (path.endsWith("/ports")) {
        if (opts.portsError) return Promise.reject(opts.portsError);
        return Promise.resolve({
          listening_ports: [
            { port: 22, address: "0.0.0.0", process: "sshd" },
            { port: 8080, address: "0.0.0.0", process: "app" },
          ],
        });
      }
      return Promise.resolve({ slug: opts.slug ?? "web-1" });
    },
    post: (path: string, body: unknown) => {
      posts.push({ path, body });
      return Promise.resolve({
        token: { id: "tok-1", expires_at: "2026-01-01T01:00:00Z" },
        plaintext_token: "rt_secret",
        runner_gateway_url: "wss://gateway.example.test/ws/runner",
        runner_install_url: "https://get.example.test/",
      });
    },
    del: (path: string) => {
      deletes.push(path);
      return Promise.resolve({});
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
    posts,
    deletes,
  };
}

const parsed = (r: Result): Record<string, unknown> =>
  JSON.parse(r.content[0]?.text ?? "{}") as Record<string, unknown>;

test("create_server_setup_script mints a token and returns a hardened script", async () => {
  const h = harness();
  const r = await h.tool("create_server_setup_script")({ organization: "acme", name: "web-2", hostname: "web-2.internal" });
  const script = parsed(r)["script"] as string;

  expect(h.posts).toEqual([{ path: "/admin/runners/tokens?tenant_id=T1", body: { label: "web-2" } }]);
  expect(script).toContain("https://get.example.test/setup");
  expect(script).toContain("--token rt_secret");
  expect(script).toContain("--harden");
  expect(script).toContain("--hostname web-2.internal");
  expect(script).not.toContain("sudo -n");
});

test("create_server_setup_script rejects unsafe input before minting a token", async () => {
  const h = harness();
  const r = await h.tool("create_server_setup_script")({ organization: "acme", name: "web-2", firewall_allow: ["80;reboot"] });

  expect(r.isError).toBe(true);
  expect(h.posts).toEqual([]);
});

test("plan_server_hardening reports blocked ports and the command, leaving out --yes", async () => {
  const r = await harness().tool("plan_server_hardening")({ organization: "acme", server_id: "S1" });

  expect(parsed(r)["blocked_ports"]).toEqual([8080]);
  expect(parsed(r)["command"]).toBe("reoclo servers harden web-1");
});

test("plan_server_hardening still answers when the port scan is unavailable", async () => {
  const h = harness({ portsError: new ApiError(503, "Runner is offline", "/ports") });
  const r = await h.tool("plan_server_hardening")({ organization: "acme", server_id: "S1" });

  expect(parsed(r)["port_scan_error"]).toBe("Runner is offline");
  expect(parsed(r)["command"]).toBe("reoclo servers harden web-1");
});

test("decommission_server deletes only when confirm_slug matches", async () => {
  const h = harness();
  const refused = await h.tool("decommission_server")({ organization: "acme", server_id: "S1", confirm_slug: "web-2" });
  expect(refused.isError).toBe(true);
  expect(h.deletes).toEqual([]);

  const r = await h.tool("decommission_server")({ organization: "acme", server_id: "S1", confirm_slug: "web-1" });
  expect(parsed(r)["decommissioned"]).toBe(true);
  expect(h.deletes).toEqual(["/tenants/T1/servers/S1"]);
});
