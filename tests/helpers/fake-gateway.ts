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
  // In-memory state per gateway instance — reset on each fresh startFakeGateway().
  const envVars = new Map<string, Map<string, string>>();
  const domains: Array<{
    id: string;
    tenant_id: string;
    fqdn: string;
    status: string;
    application_id: string | null;
    bound_server_id: string | null;
    verified_domain_id: string | null;
    scheme_hint: string | null;
  }> = [];
  const deployments: Array<{ id: string; status: string }> = [];
  let nextId = 1;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
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

      // POST /mcp/tenants/{tid}/applications/{app_id}/deploy
      const deployMatch = url.pathname.match(
        new RegExp(`^/mcp/tenants/${TENANT_ID}/applications/([^/]+)/deploy$`),
      );
      if (deployMatch && req.method === "POST") {
        const id = `00000000-0000-0000-0000-${String(nextId++).padStart(12, "0")}`;
        const dep = { id, status: "queued" };
        deployments.push(dep);
        return Response.json(dep);
      }

      // GET /mcp/tenants/{tid}/applications/{app_id}/deployments/{dep_id}
      const depGetMatch = url.pathname.match(
        new RegExp(
          `^/mcp/tenants/${TENANT_ID}/applications/[^/]+/deployments/([^/]+)$`,
        ),
      );
      if (depGetMatch && req.method === "GET") {
        const dep = deployments.find((d) => d.id === depGetMatch[1]);
        if (!dep) return new Response("not found", { status: 404 });
        // Immediately return "succeeded" so --wait completes on the first poll.
        return Response.json({ ...dep, status: "succeeded" });
      }

      // /mcp/tenants/{tid}/applications/{app_id}/env/
      const envCollectionMatch = url.pathname.match(
        new RegExp(`^/mcp/tenants/${TENANT_ID}/applications/([^/]+)/env/$`),
      );
      if (envCollectionMatch) {
        const appId = envCollectionMatch[1] ?? "";
        if (!envVars.has(appId)) envVars.set(appId, new Map());
        const map = envVars.get(appId)!;

        if (req.method === "GET") {
          const items = Array.from(map.keys()).map((k) => ({
            key: k,
            updated_at: "2026-01-01T00:00:00Z",
          }));
          return Response.json(items);
        }
        if (req.method === "PATCH") {
          const body = (await req.json()) as { vars: Array<{ key: string; value: string }> };
          for (const v of body.vars) map.set(v.key, v.value);
          const items = Array.from(map.keys()).map((k) => ({
            key: k,
            updated_at: "2026-01-01T00:00:00Z",
          }));
          return Response.json(items);
        }
      }

      // DELETE /mcp/tenants/{tid}/applications/{app_id}/env/{key}
      const envKeyMatch = url.pathname.match(
        new RegExp(
          `^/mcp/tenants/${TENANT_ID}/applications/([^/]+)/env/([^/]+)$`,
        ),
      );
      if (envKeyMatch && req.method === "DELETE") {
        const appId = envKeyMatch[1] ?? "";
        const key = envKeyMatch[2] ?? "";
        envVars.get(appId)?.delete(key);
        return new Response(null, { status: 204 });
      }

      // /mcp/tenants/{tid}/domains/
      if (url.pathname === `/mcp/tenants/${TENANT_ID}/domains/`) {
        if (req.method === "GET") return Response.json(domains);
        if (req.method === "POST") {
          const body = (await req.json()) as { fqdn: string };
          const id = `00000000-0000-0000-0000-${String(nextId++).padStart(12, "0")}`;
          const d = {
            id,
            tenant_id: TENANT_ID,
            fqdn: body.fqdn,
            status: "pending",
            application_id: null,
            bound_server_id: null,
            verified_domain_id: null,
            scheme_hint: null,
          };
          domains.push(d);
          return Response.json(d);
        }
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
