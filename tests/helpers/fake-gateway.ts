// tests/helpers/fake-gateway.ts
//
// Reusable in-process fake of the Reoclo public gateway for CLI integration
// tests. Serves the /mcp/ prefix used by tenant API keys.
//
// Design: every test gets its own instance via `startFakeGateway()`. The
// fixture holds canned objects you can mutate before launching the CLI to
// simulate different scenarios.

const TENANT_ID = "00000000-0000-0000-0000-00000000aaaa";
const TOKEN = "rk_t_test";

export interface FakeGateway {
  url: string;
  tenantId: string;
  token: string;
  stop: () => void;
}

export function startFakeGateway(): FakeGateway {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      if (auth !== `Bearer ${TOKEN}`) return new Response("unauth", { status: 401 });

      // /mcp/auth/me
      if (url.pathname === "/mcp/auth/me") {
        return Response.json({
          id: "user-1",
          email: "test@example.com",
          tenant_id: TENANT_ID,
          tenant_slug: "acme",
          roles: ["member"],
        });
      }

      // /mcp/tenants/{tid}/servers/  (bare array)
      if (url.pathname === `/mcp/tenants/${TENANT_ID}/servers/`) {
        return Response.json([
          {
            id: "00000000-0000-0000-0000-00000000bbbb",
            name: "srv-1",
            hostname: "srv-1.local",
            public_ip: "1.1.1.1",
            status: "online",
            runner_version: "1.3.0",
            connection_type: "runner",
            created_at: "2026-01-01T00:00:00Z",
          },
        ]);
      }

      // /mcp/tenants/{tid}/servers/{id}
      const srvMatch = url.pathname.match(
        new RegExp(`^/mcp/tenants/${TENANT_ID}/servers/([^/]+)$`),
      );
      if (srvMatch) {
        return Response.json({
          id: srvMatch[1] ?? "",
          name: "srv-1",
          hostname: "srv-1.local",
          public_ip: "1.1.1.1",
          status: "online",
          connection_type: "runner",
          created_at: "2026-01-01T00:00:00Z",
        });
      }

      // /mcp/tenants/{tid}/applications/?limit=200  (paginated)
      if (url.pathname === `/mcp/tenants/${TENANT_ID}/applications/`) {
        return Response.json({
          items: [
            {
              id: "00000000-0000-0000-0000-00000000cccc",
              slug: "app-1",
              name: "App One",
              server_id: "00000000-0000-0000-0000-00000000bbbb",
              repository_id: null,
              current_deployment_id: null,
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
          total: 1,
          skip: 0,
          limit: 200,
        });
      }

      // /mcp/tenants/{tid}/applications/{id}
      const appMatch = url.pathname.match(
        new RegExp(`^/mcp/tenants/${TENANT_ID}/applications/([^/]+)$`),
      );
      if (appMatch) {
        return Response.json({
          id: appMatch[1] ?? "",
          slug: "app-1",
          name: "App One",
          server_id: "00000000-0000-0000-0000-00000000bbbb",
          repository_id: null,
          current_deployment_id: null,
          created_at: "2026-01-01T00:00:00Z",
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    tenantId: TENANT_ID,
    token: TOKEN,
    stop: () => {
      void server.stop();
    },
  };
}
