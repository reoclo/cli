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
// Automation (rca_*) key accepted by the external-deploy session route. The
// CLI's `deploy sync` exchanges it for a short-lived rds_* session token.
const AUTOMATION_KEY = "rca_test";

export interface FakeGateway {
  url: string;
  tenantId: string;
  token: string;
  /** rca_* automation key the external-deploy session route accepts. */
  automationKey: string;
  /** Session ids passed to DELETE /external-deploy/session/{id} (revoke). */
  deployRevokes: string[];
  stop: () => void;
}

export function startFakeGateway(): FakeGateway {
  // In-memory state per gateway instance — reset on each fresh startFakeGateway().
  const envVars = new Map<string, Map<string, string>>();
  const monitors = new Map<string, Record<string, unknown>>();
  const statusPages = new Map<string, Record<string, unknown>>();
  const incidents = new Map<string, Record<string, unknown>>();
  const incidentUpdates = new Map<string, Array<Record<string, unknown>>>();
  const scheduledOps = new Map<string, Record<string, unknown>>();
  const scheduledRuns = new Map<string, Array<Record<string, unknown>>>();
  const domains: Array<{
    id: string;
    tenant_id: string;
    fqdn: string;
    status: string;
    application_id: string | null;
    bound_server_id: string | null;
    verified_domain_id: string | null;
    scheme_hint: string | null;
  }> = [
    {
      id: "dom-1",
      tenant_id: TENANT_ID,
      fqdn: "example.com",
      status: "verified",
      application_id: null,
      bound_server_id: null,
      verified_domain_id: null,
      scheme_hint: null,
    },
  ];
  const deployments: Array<{ id: string; status: string }> = [];
  const repositories = [
    {
      id: "11111111-1111-1111-1111-111111111111",
      tenant_id: TENANT_ID,
      full_name: "acme/web",
      name: "web",
      owner_login: "acme",
      is_private: false,
      default_branch: "main",
      status: "active",
      last_push_at: "2026-05-19T00:00:00Z",
    },
    {
      id: "22222222-2222-2222-2222-222222222222",
      tenant_id: TENANT_ID,
      full_name: "acme/api",
      name: "api",
      owner_login: "acme",
      is_private: true,
      default_branch: "develop",
      status: "active",
      last_push_at: "2026-05-18T00:00:00Z",
    },
  ];
  const repoBranches: Record<string, Array<{ name: string; is_default: boolean }>> = {
    "11111111-1111-1111-1111-111111111111": [
      { name: "main", is_default: true },
      { name: "feat/x", is_default: false },
    ],
    "22222222-2222-2222-2222-222222222222": [{ name: "develop", is_default: true }],
  };
  const auditLogs: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 250; i++) {
    auditLogs.push({
      id: `audit-${i}`,
      tenant_id: TENANT_ID,
      actor_id: i % 2 === 0 ? "user-1" : "user-2",
      actor_email: i % 2 === 0 ? "a@x.com" : "b@x.com",
      action: i % 3 === 0 ? "deploy_succeeded" : "update",
      resource_type: i % 4 === 0 ? "server" : "application",
      resource_id: `res-${i}`,
      resource_name: `name-${i}`,
      changes: {},
      metadata: {},
      ip_address: "127.0.0.1",
      created_at: `2026-05-${String(19 - (i % 18)).padStart(2, "0")}T00:00:00Z`,
      updated_at: `2026-05-${String(19 - (i % 18)).padStart(2, "0")}T00:00:00Z`,
    });
  }

  const users = [
    { id: "user-1", email: "a@x.com" },
    { id: "user-2", email: "b@x.com" },
  ];

  const registryCreds = new Map<string, Record<string, unknown>>();
  registryCreds.set("33333333-3333-3333-3333-333333333333", {
    id: "33333333-3333-3333-3333-333333333333",
    tenant_id: TENANT_ID,
    name: "dockerhub-main",
    registry_type: "docker",
    registry_url: "https://index.docker.io/v1/",
    username: "acme-bot",
    description: "Primary Docker Hub creds",
    encrypted_credential: "***MASKED***",
    created_at: "2026-05-19T00:00:00Z",
    updated_at: "2026-05-19T00:00:00Z",
  });

  const fleetContainers: Array<Record<string, unknown>> = [
    {
      server_id: "00000000-0000-0000-0000-00000000bbbb",
      server_hostname: "srv-1",
      name: "web-1",
      image: "nginx:1.27",
      status: "running",
      kind: "container",
      application_slug: "app-1",
    },
    {
      server_id: "00000000-0000-0000-0000-00000000bbbb",
      server_hostname: "srv-1",
      name: "worker-1",
      image: "reoclo/worker:latest",
      status: "exited",
      kind: "container",
      application_slug: "app-1",
    },
  ];
  const logEntries: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 600; i++) {
    logEntries.push({
      ts: `2026-05-19T${String(Math.floor(i / 100)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`,
      level: i % 5 === 0 ? "error" : i % 3 === 0 ? "warn" : "info",
      message: `log line ${i}: ${i % 7 === 0 ? "panic" : "ok"}`,
      server_id: i % 2 === 0 ? "srv-1" : "srv-2",
      server_name: i % 2 === 0 ? "web-1" : "web-2",
      source_type: i % 4 === 0 ? "container" : "system",
      source_name: i % 4 === 0 ? "app-container" : "kernel",
      stream: i % 3 === 0 ? "stderr" : "stdout",
    });
  }

  const appConfigs = new Map<string, Record<string, unknown>>();
  appConfigs.set("11111111-aaaa-aaaa-aaaa-111111111111", {
    build: { buildpack: "node", docker_image: null },
    deploy: { replicas: 1, container_port: 3000, host_port: 8080, env: { FOO: "1" } },
  });

  function mergeDeep(
    target: Record<string, unknown>,
    src: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...target };
    for (const [k, v] of Object.entries(src)) {
      if (
        typeof v === "object" &&
        v !== null &&
        !Array.isArray(v) &&
        typeof out[k] === "object" &&
        out[k] !== null &&
        !Array.isArray(out[k])
      ) {
        out[k] = mergeDeep(out[k] as Record<string, unknown>, v as Record<string, unknown>);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  let nextId = 1;

  // External-deploy two-token state (per gateway instance).
  let deploySessionToken: string | null = null;
  let deploySessionId: string | null = null;
  const deployRevokes: string[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");

      // External-deploy is ROOT-mounted and uses rca_*/rds_* bearers, so it is
      // handled before the tenant-token (rk_t_test) auth wall below.
      if (url.pathname.startsWith("/external-deploy/")) {
        // POST /external-deploy/session — exchange the rca_* key for an rds_* token.
        if (req.method === "POST" && url.pathname === "/external-deploy/session") {
          if (auth !== `Bearer ${AUTOMATION_KEY}`) {
            return Response.json({ detail: "API key lacks `external_deploy` scope" }, { status: 403 });
          }
          const body = (await req.json()) as { container_names?: string[] };
          const names = body.container_names ?? [];
          deploySessionId = "sess-int-1";
          deploySessionToken = "rds_int_token";
          return Response.json(
            {
              session_id: deploySessionId,
              session_token: deploySessionToken,
              expires_at: "2026-06-06T00:15:00Z",
              applications: names.map((n, i) => ({
                id: `app-${i}`,
                linked_container_name: n,
                container_port: 0,
                bound_fqdns: [`${n}.example.com`],
              })),
              unmatched: [],
            },
            { status: 201 },
          );
        }

        // POST /external-deploy/sync — requires the rds_* session token. A
        // container whose name contains "conflict" comes back as a conflict; an
        // all-conflict response is a 409 (mirrors the real API).
        if (req.method === "POST" && url.pathname === "/external-deploy/sync") {
          if (!deploySessionToken || auth !== `Bearer ${deploySessionToken}`) {
            return Response.json(
              { detail: "Valid rds_* deploy session token required" },
              { status: 401 },
            );
          }
          const body = (await req.json()) as {
            deployments?: Array<{ container_name: string; container_port: number }>;
          };
          const deployments = body.deployments ?? [];
          const results = deployments.map((d) => {
            const conflict = d.container_name.includes("conflict");
            return {
              application_id: `app-${d.container_name}`,
              container_name: d.container_name,
              status: conflict ? "conflict" : "synced",
              signature_hash: "sig",
              synced_fqdns: conflict ? [] : [`${d.container_name}.example.com`],
              reason: conflict ? "route held by another signature" : null,
            };
          });
          const allConflict = results.length > 0 && results.every((r) => r.status === "conflict");
          return Response.json(
            { session_id: deploySessionId, results, errors: [] },
            { status: allConflict ? 409 : 200 },
          );
        }

        // DELETE /external-deploy/session/{id} — self-revoke with the rds_* token.
        if (req.method === "DELETE" && url.pathname.startsWith("/external-deploy/session/")) {
          if (!deploySessionToken || auth !== `Bearer ${deploySessionToken}`) {
            return new Response("unauth", { status: 401 });
          }
          deployRevokes.push(url.pathname.split("/").pop() ?? "");
          return new Response(null, { status: 204 });
        }

        return new Response("not found", { status: 404 });
      }

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

      // /mcp/auth/me/capabilities
      if (url.pathname === "/mcp/auth/me/capabilities") {
        return Response.json({
          grants: [
            { verb: "server:exec", scope_kind: "tenant", scope_id: null },
            { verb: "container:read", scope_kind: "tenant", scope_id: null },
            { verb: "container:logs:tail", scope_kind: "tenant", scope_id: null },
            { verb: "container:write", scope_kind: "tenant", scope_id: null },
            { verb: "container:exec", scope_kind: "tenant", scope_id: null },
            { verb: "app:deploy", scope_kind: "tenant", scope_id: null },
            { verb: "app:env:write", scope_kind: "tenant", scope_id: null },
            { verb: "tenant:cost:read", scope_kind: "tenant", scope_id: null },
          ],
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

      // /mcp/tenants/{tid}/deployments/{did}/stages
      {
        const m = url.pathname.match(/^\/mcp\/tenants\/[^/]+\/deployments\/([^/]+)\/stages$/);
        if (m) {
          return Response.json([
            { name: "build", status: "succeeded", started_at: "2026-05-19T10:00:00Z", ended_at: "2026-05-19T10:01:30Z", exit_code: 0 },
            { name: "push", status: "succeeded", started_at: "2026-05-19T10:01:30Z", ended_at: "2026-05-19T10:02:00Z", exit_code: 0 },
            { name: "deploy", status: "succeeded", started_at: "2026-05-19T10:02:00Z", ended_at: "2026-05-19T10:02:45Z", exit_code: 0 },
          ]);
        }
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

      // /mcp/tenants/{tid}/domains/{did}/dns
      {
        const m = url.pathname.match(/^\/mcp\/tenants\/[^/]+\/domains\/([^/]+)\/dns$/);
        if (m) {
          return Response.json({
            records: [
              { type: "A", name: "example.com", expected: "1.2.3.4", observed: "1.2.3.4", status: "ok" },
              { type: "AAAA", name: "example.com", expected: "2001:db8::1", observed: "", status: "missing" },
            ],
            status: "mismatch",
          });
        }
      }

      // /mcp/tenants/{tid}/dns/overview — tenant-wide overview that
      // `domains dns` and similar callers consume. Mirrors the per-domain
      // /domains/{did}/dns data above but in the new OverviewResponse
      // envelope (record_type / value / observed_values / dns_status).
      if (url.pathname === `/mcp/tenants/${TENANT_ID}/dns/overview`) {
        return Response.json({
          servers: [
            {
              domains: [
                {
                  domain_id: "dom-1",
                  fqdn: "example.com",
                  dns_status: "mismatch",
                  records: [
                    {
                      record_type: "A",
                      name: "example.com",
                      value: "1.2.3.4",
                      observed_values: ["1.2.3.4"],
                      status: "ok",
                    },
                    {
                      record_type: "AAAA",
                      name: "example.com",
                      value: "2001:db8::1",
                      observed_values: [],
                      status: "missing",
                    },
                  ],
                },
              ],
            },
          ],
          unbound_domains: [],
        });
      }

      // /mcp/tenants/{tid}/domains/{did}/health
      {
        const m = url.pathname.match(/^\/mcp\/tenants\/[^/]+\/domains\/([^/]+)\/health$/);
        if (m) {
          return Response.json({
            dns: { status: "ok" },
            tls: { status: "ok", cert_expires_at: "2026-08-19T00:00:00Z" },
            uptime: { status: "ok", probe_at: "2026-05-19T10:00:00Z" },
          });
        }
      }

      // /mcp/tenants/{tid}/domains/{did}   (DELETE)
      {
        const m = url.pathname.match(/^\/mcp\/tenants\/[^/]+\/domains\/([^/]+)$/);
        if (m && req.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
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

      // POST /mcp/tenants/{tid}/applications/{app_id}/restart
      const restartMatch = url.pathname.match(
        new RegExp(`^/mcp/tenants/${TENANT_ID}/applications/([^/]+)/restart$`),
      );
      if (restartMatch && req.method === "POST") {
        return Response.json({
          application_id: restartMatch[1] ?? "",
          container_name: "reoclo-acme-app-1",
          exit_code: 0,
          stdout: "",
          stderr: "",
        });
      }

      // GET /mcp/tenants/{tid}/applications/{app_id}/logs
      const appLogsMatch = url.pathname.match(
        new RegExp(`^/mcp/tenants/${TENANT_ID}/applications/([^/]+)/logs$`),
      );
      if (appLogsMatch && req.method === "GET") {
        return Response.json({
          server_id: "00000000-0000-0000-0000-00000000bbbb",
          server_name: "srv-1",
          source_type: "container",
          source_name: "reoclo-acme-app-1",
          fetched_at: "2026-04-25T00:00:00Z",
          entries: [
            {
              timestamp: "2026-04-25T00:00:01Z",
              level: "info",
              message: "boot ok",
              server_id: "00000000-0000-0000-0000-00000000bbbb",
              server_name: "srv-1",
              source_type: "container",
              source_name: "reoclo-acme-app-1",
            },
            {
              timestamp: "2026-04-25T00:00:02Z",
              level: "warn",
              message: "slow query",
              server_id: "00000000-0000-0000-0000-00000000bbbb",
              server_name: "srv-1",
              source_type: "container",
              source_name: "reoclo-acme-app-1",
            },
          ],
        });
      }

      // POST /mcp/tenants/{tid}/servers/{server_id}/exec
      const execMatch = url.pathname.match(
        new RegExp(`^/mcp/tenants/${TENANT_ID}/servers/([^/]+)/exec$`),
      );
      if (execMatch && req.method === "POST") {
        const body = (await req.json()) as { command?: string };
        const cmd = body.command ?? "";
        if (cmd.startsWith("fail")) {
          return Response.json({
            exit_code: 1,
            stdout: "",
            stderr: "boom\n",
            truncated: false,
          });
        }
        return Response.json({
          exit_code: 0,
          stdout: `ran: ${cmd}\n`,
          stderr: "",
          truncated: false,
        });
      }

      // /mcp/tenants/{tid}/applications/{aid}/config
      {
        const m = url.pathname.match(/^\/mcp\/tenants\/[^/]+\/applications\/([^/]+)\/config$/);
        if (m) {
          const aid = m[1] ?? "";
          if (req.method === "GET") {
            const cfg = appConfigs.get(aid);
            if (!cfg) return new Response("not found", { status: 404 });
            return Response.json(cfg);
          }
          if (req.method === "PATCH") {
            const body = (await req.json()) as { config?: Record<string, unknown> };
            if (!body.config || Object.keys(body.config).length === 0) {
              return Response.json({ detail: "empty patch" }, { status: 422 });
            }
            const existing = appConfigs.get(aid) ?? {};
            const merged = mergeDeep(existing, body.config);
            appConfigs.set(aid, merged);
            return Response.json(merged);
          }
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

      // /mcp/tenants/{tid}/monitors  (collection, NO trailing slash)
      if (url.pathname === `/mcp/tenants/${TENANT_ID}/monitors`) {
        if (req.method === "GET") return Response.json([...monitors.values()]);
        if (req.method === "POST") {
          const body = (await req.json()) as Record<string, unknown>;
          const id = `00000000-0000-0000-0000-${String(nextId++).padStart(12, "0")}`;
          const m = {
            id,
            name: body.name,
            url: body.url,
            status: "active",
            check_interval_seconds: body.check_interval_seconds ?? 60,
          };
          monitors.set(id, m);
          return Response.json(m);
        }
      }
      // /mcp/tenants/{tid}/monitors/{id}  and  /{id}/pause | /resume
      const monMatch = url.pathname.match(
        new RegExp(`^/mcp/tenants/${TENANT_ID}/monitors/([^/]+?)(?:/(pause|resume))?$`),
      );
      if (monMatch) {
        const id = monMatch[1] ?? "";
        const action = monMatch[2];
        const m = monitors.get(id);
        if (!m) return new Response("not found", { status: 404 });
        if (action && req.method === "POST") {
          m.status = action === "pause" ? "paused" : "active";
          return Response.json(m);
        }
        if (req.method === "GET") return Response.json(m);
        if (req.method === "PATCH") {
          const body = (await req.json()) as Record<string, unknown>;
          Object.assign(m, body);
          return Response.json(m);
        }
        if (req.method === "DELETE") {
          monitors.delete(id);
          return new Response(null, { status: 204 });
        }
      }

      // /mcp/tenants/{tid}/status-pages/  (collection, WITH trailing slash)
      if (url.pathname === `/mcp/tenants/${TENANT_ID}/status-pages/`) {
        if (req.method === "GET") return Response.json([...statusPages.values()]);
        if (req.method === "POST") {
          const body = (await req.json()) as Record<string, unknown>;
          const id = `00000000-0000-0000-0000-${String(nextId++).padStart(12, "0")}`;
          const sp = {
            id,
            title: body.title ?? "Status",
            slug: `sp-${id.slice(-4)}`,
            is_published: false,
            label: body.label ?? null,
            description: body.description ?? null,
          };
          statusPages.set(id, sp);
          return Response.json(sp);
        }
      }
      // /mcp/tenants/{tid}/status-pages/{id}  (item, NO trailing slash)
      const spMatch = url.pathname.match(
        new RegExp(`^/mcp/tenants/${TENANT_ID}/status-pages/([^/]+)$`),
      );
      if (spMatch) {
        const id = spMatch[1] ?? "";
        const sp = statusPages.get(id);
        if (!sp) return new Response("not found", { status: 404 });
        if (req.method === "GET") return Response.json(sp);
        if (req.method === "PATCH") {
          Object.assign(sp, (await req.json()) as Record<string, unknown>);
          return Response.json(sp);
        }
        if (req.method === "DELETE") {
          statusPages.delete(id);
          return new Response(null, { status: 204 });
        }
      }

      // /mcp/tenants/{tid}/incidents/  (collection, WITH trailing slash)
      if (url.pathname === `/mcp/tenants/${TENANT_ID}/incidents/`) {
        if (req.method === "GET") {
          const stateFilter = url.searchParams.get("state");
          const all = [...incidents.values()];
          return Response.json(
            stateFilter ? all.filter((i) => i.state === stateFilter) : all,
          );
        }
        if (req.method === "POST") {
          const body = (await req.json()) as Record<string, unknown>;
          const id = `00000000-0000-0000-0000-${String(nextId++).padStart(12, "0")}`;
          const inc = {
            id,
            title: body.title,
            summary: body.summary ?? null,
            severity: body.severity ?? "major",
            state: "investigating",
            started_at: "2026-01-01T00:00:00Z",
            status_page_id: body.status_page_id ?? null,
          };
          incidents.set(id, inc);
          incidentUpdates.set(id, []);
          return Response.json(inc);
        }
      }
      // /mcp/tenants/{tid}/incidents/{id}/updates
      const incUpdMatch = url.pathname.match(
        new RegExp(`^/mcp/tenants/${TENANT_ID}/incidents/([^/]+)/updates$`),
      );
      if (incUpdMatch) {
        const id = incUpdMatch[1] ?? "";
        if (!incidents.has(id)) return new Response("not found", { status: 404 });
        const ups = incidentUpdates.get(id) ?? [];
        if (req.method === "GET") return Response.json(ups);
        if (req.method === "POST") {
          const body = (await req.json()) as Record<string, unknown>;
          const u = {
            message: body.message,
            state: body.state ?? null,
            created_at: "2026-01-02T00:00:00Z",
          };
          ups.push(u);
          incidentUpdates.set(id, ups);
          if (body.state) (incidents.get(id) as Record<string, unknown>).state = body.state;
          return Response.json(u);
        }
      }
      // /mcp/tenants/{tid}/incidents/{id}
      const incMatch = url.pathname.match(
        new RegExp(`^/mcp/tenants/${TENANT_ID}/incidents/([^/]+)$`),
      );
      if (incMatch) {
        const id = incMatch[1] ?? "";
        const inc = incidents.get(id);
        if (!inc) return new Response("not found", { status: 404 });
        if (req.method === "GET") return Response.json(inc);
        if (req.method === "PATCH") {
          Object.assign(inc, (await req.json()) as Record<string, unknown>);
          return Response.json(inc);
        }
      }

      // /mcp/tenants/{tid}/scheduled-operations  (collection, NO trailing slash)
      if (url.pathname === `/mcp/tenants/${TENANT_ID}/scheduled-operations`) {
        if (req.method === "GET") {
          const statusFilter = url.searchParams.get("status");
          const typeFilter = url.searchParams.get("operation_type");
          let all = [...scheduledOps.values()];
          if (statusFilter) all = all.filter((o) => o.status === statusFilter);
          if (typeFilter) all = all.filter((o) => o.operation_type === typeFilter);
          return Response.json(all);
        }
        if (req.method === "POST") {
          const body = (await req.json()) as Record<string, unknown>;
          const id = `00000000-0000-0000-0000-${String(nextId++).padStart(12, "0")}`;
          const op = {
            id,
            name: body.name,
            description: body.description ?? "",
            operation_type: body.operation_type,
            schedule_kind: body.schedule_kind,
            status: "ACTIVE",
            cron_expression: body.cron_expression ?? null,
            timezone: body.timezone ?? "UTC",
            scheduled_at: body.scheduled_at ?? null,
            server_id: body.server_id ?? null,
            application_id: body.application_id ?? null,
            params: body.params ?? {},
            state: { next_run_at: "2026-02-01T00:00:00Z", last_run_status: null },
          };
          scheduledOps.set(id, op);
          return Response.json(op);
        }
      }
      // /mcp/tenants/{tid}/scheduled-operations/{id}/(pause|resume|trigger)
      const soActionMatch = url.pathname.match(
        new RegExp(
          `^/mcp/tenants/${TENANT_ID}/scheduled-operations/([^/]+)/(pause|resume|trigger)$`,
        ),
      );
      if (soActionMatch && req.method === "POST") {
        const id = soActionMatch[1] ?? "";
        const action = soActionMatch[2];
        const op = scheduledOps.get(id);
        if (!op) return new Response("not found", { status: 404 });
        if (action === "pause") {
          op.status = "PAUSED";
          return Response.json(op);
        }
        if (action === "resume") {
          op.status = "ACTIVE";
          return Response.json(op);
        }
        // trigger → create + return a run
        const runId = `00000000-0000-0000-0000-${String(nextId++).padStart(12, "0")}`;
        const run = {
          id: runId,
          scheduled_operation_id: id,
          status: "RUNNING",
          scheduled_for: "2026-02-01T00:00:00Z",
          started_at: "2026-02-01T00:00:01Z",
          duration_seconds: null,
          attempt: 1,
          output: "triggered manually\nstep 1 ok",
        };
        const runs = scheduledRuns.get(id) ?? [];
        runs.push(run);
        scheduledRuns.set(id, runs);
        return Response.json(run);
      }
      // /mcp/tenants/{tid}/scheduled-operations/{id}/runs/{runId}
      const soRunMatch = url.pathname.match(
        new RegExp(`^/mcp/tenants/${TENANT_ID}/scheduled-operations/([^/]+)/runs/([^/]+)$`),
      );
      if (soRunMatch && req.method === "GET") {
        const id = soRunMatch[1] ?? "";
        const runId = soRunMatch[2] ?? "";
        const run = (scheduledRuns.get(id) ?? []).find((r) => r.id === runId);
        if (!run) return new Response("not found", { status: 404 });
        return Response.json(run);
      }
      // /mcp/tenants/{tid}/scheduled-operations/{id}/runs
      const soRunsMatch = url.pathname.match(
        new RegExp(`^/mcp/tenants/${TENANT_ID}/scheduled-operations/([^/]+)/runs$`),
      );
      if (soRunsMatch && req.method === "GET") {
        const id = soRunsMatch[1] ?? "";
        const statusFilter = url.searchParams.get("status");
        let runs = scheduledRuns.get(id) ?? [];
        if (statusFilter) runs = runs.filter((r) => r.status === statusFilter);
        return Response.json(runs);
      }
      // /mcp/tenants/{tid}/scheduled-operations/{id}  (item)
      const soItemMatch = url.pathname.match(
        new RegExp(`^/mcp/tenants/${TENANT_ID}/scheduled-operations/([^/]+)$`),
      );
      if (soItemMatch) {
        const id = soItemMatch[1] ?? "";
        const op = scheduledOps.get(id);
        if (!op) return new Response("not found", { status: 404 });
        if (req.method === "GET") return Response.json(op);
        if (req.method === "PATCH") {
          Object.assign(op, (await req.json()) as Record<string, unknown>);
          return Response.json(op);
        }
        if (req.method === "DELETE") {
          scheduledOps.delete(id);
          return new Response(null, { status: 204 });
        }
      }

      // /mcp/tenants/{tid}/runtime/containers  — paginated, 1 per page
      if (url.pathname === `/mcp/tenants/${TENANT_ID}/runtime/containers`) {
        if (req.method === "GET") {
          const statusFilter = url.searchParams.get("status");
          const serverFilter = url.searchParams.get("server_id");
          let rows = fleetContainers;
          if (statusFilter) rows = rows.filter((c) => c.status === statusFilter);
          if (serverFilter) rows = rows.filter((c) => c.server_id === serverFilter);
          const offset = Number(url.searchParams.get("cursor") ?? "0");
          const page = rows.slice(offset, offset + 1);
          const nextOffset = offset + 1;
          return Response.json({
            containers: page,
            next_cursor: nextOffset < rows.length ? String(nextOffset) : null,
            stale_servers: [],
          });
        }
      }
      // /mcp/tenants/{tid}/runtime/refresh
      if (
        url.pathname === `/mcp/tenants/${TENANT_ID}/runtime/refresh` &&
        req.method === "POST"
      ) {
        return Response.json({ refreshed: true });
      }

      // /mcp/tenants/{tid}/runtime/servers/{sid}/containers/{name}/(recreate|scale|labels)
      const runtimeActionMatch = url.pathname.match(
        new RegExp(
          `^/mcp/tenants/${TENANT_ID}/runtime/servers/([^/]+)/containers/([^/]+)/(recreate|scale|labels)$`,
        ),
      );
      if (runtimeActionMatch) {
        const name = runtimeActionMatch[2] ?? "";
        const action = runtimeActionMatch[3];
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        if (action === "recreate" && req.method === "POST") {
          return Response.json({
            container_name: name,
            kind: "container",
            before: { env: {}, labels: {}, ports: [] },
            after: { env: body.env ?? {}, labels: body.labels ?? {}, ports: body.ports ?? [] },
            persist: body.persist === true,
            audit_log_id: "00000000-0000-0000-0000-0000000000a1",
            warnings: [],
          });
        }
        if (action === "scale" && req.method === "POST") {
          return Response.json({
            container_name: name,
            previous_replicas: 1,
            new_replicas: body.replicas ?? 1,
            audit_log_id: "00000000-0000-0000-0000-0000000000a2",
          });
        }
        if (action === "labels" && req.method === "PATCH") {
          return Response.json({
            container_name: name,
            before_labels: {},
            after_labels: body.labels ?? {},
            audit_log_id: "00000000-0000-0000-0000-0000000000a3",
          });
        }
      }

      // /mcp/tenants/{tid}/servers/{sid}/containers/{name}/inspect
      const inspectMatch = url.pathname.match(
        new RegExp(`^/mcp/tenants/${TENANT_ID}/servers/([^/]+)/containers/([^/]+)/inspect$`),
      );
      if (inspectMatch && req.method === "GET") {
        return Response.json({
          container_name: inspectMatch[2],
          container_id: "deadbeef",
          image: "nginx:1.27",
          status: "running",
          state: "running",
          env_vars: [{ key: "PORT", value: "8080" }],
          ports: [{ container_port: 80, host_port: 8080, protocol: "tcp" }],
          resource_limits: { cpu_cores: null, memory_mb: null },
          created: "2026-01-01T00:00:00Z",
        });
      }
      // /mcp/tenants/{tid}/servers/{sid}/containers/{name}/logs
      const clogsMatch = url.pathname.match(
        new RegExp(`^/mcp/tenants/${TENANT_ID}/servers/([^/]+)/containers/([^/]+)/logs$`),
      );
      if (clogsMatch && req.method === "GET") {
        return Response.json({
          container_name: clogsMatch[2],
          stdout: "log line 1\nlog line 2",
          stderr: "",
          tail: Number(url.searchParams.get("tail") ?? "200"),
        });
      }
      // /mcp/tenants/{tid}/servers/{sid}/containers/{name}/(start|stop|restart)
      const cActionMatch = url.pathname.match(
        new RegExp(
          `^/mcp/tenants/${TENANT_ID}/servers/([^/]+)/containers/([^/]+)/(start|stop|restart)$`,
        ),
      );
      if (cActionMatch && req.method === "POST") {
        return Response.json({
          success: true,
          container_name: cActionMatch[2],
          action: cActionMatch[3],
          message: "ok",
        });
      }

      // /mcp/tenants/{tid}/servers/{sid}/containers   (live per-server list)
      const srvContainersMatch = url.pathname.match(
        new RegExp(`^/mcp/tenants/${TENANT_ID}/servers/([^/]+)/containers$`),
      );
      if (srvContainersMatch && req.method === "GET") {
        const statusFilter = url.searchParams.get("status");
        let rows: Array<Record<string, unknown>> = [
          { container_id: "c1", name: "web-1", image: "nginx:1.27", status: "running", state: "running" },
          { container_id: "c2", name: "worker-1", image: "reoclo/worker", status: "exited", state: "exited" },
        ];
        if (statusFilter) rows = rows.filter((c) => c.status === statusFilter);
        return Response.json({
          server_id: srvContainersMatch[1],
          containers: rows,
          fetched_at: "2026-01-01T00:00:00Z",
        });
      }
      // /mcp/tenants/{tid}/servers/{sid}/health
      const healthMatch = url.pathname.match(
        new RegExp(`^/mcp/tenants/${TENANT_ID}/servers/([^/]+)/health$`),
      );
      if (healthMatch && req.method === "GET") {
        return Response.json({
          status: "healthy",
          consecutive_failures: 0,
          last_latency_ms: 12,
          disk_percent: 41.2,
          disk_status: "ok",
        });
      }
      // /mcp/tenants/{tid}/servers/{sid}/ports
      const portsMatch = url.pathname.match(
        new RegExp(`^/mcp/tenants/${TENANT_ID}/servers/([^/]+)/ports$`),
      );
      if (portsMatch && req.method === "GET") {
        return Response.json({
          server_id: portsMatch[1],
          listening_ports: [
            { port: 22, protocol: "tcp", address: "0.0.0.0", process: "sshd", pid: 1, state: "LISTEN" },
            { port: 443, protocol: "tcp", address: "0.0.0.0", process: "caddy", pid: 2, state: "LISTEN" },
          ],
          docker_port_bindings: [],
          firewall: { detected: true, backend: "ufw", active: true, rules: [], raw_output: "" },
          preview_port_range: [20000, 20010],
          scanned_at: "2026-01-01T00:00:00Z",
        });
      }
      // /mcp/tenants/{tid}/servers/{sid}/uptime
      const uptimeMatch = url.pathname.match(
        new RegExp(`^/mcp/tenants/${TENANT_ID}/servers/([^/]+)/uptime$`),
      );
      if (uptimeMatch && req.method === "GET") {
        return Response.json({
          server_id: uptimeMatch[1],
          hours: Number(url.searchParams.get("hours") ?? "6"),
          slot_minutes: 5,
          buckets: [
            { slot_start: "2026-01-01T00:00:00Z", slot_end: "2026-01-01T00:05:00Z", total_checks: 5, ok_checks: 5, uptime_pct: 100, status: "healthy" },
          ],
          overall_uptime_pct: 100,
        });
      }
      // /mcp/tenants/{tid}/servers/{sid}/reboot
      const rebootMatch = url.pathname.match(
        new RegExp(`^/mcp/tenants/${TENANT_ID}/servers/([^/]+)/reboot$`),
      );
      if (rebootMatch && req.method === "POST") {
        return Response.json({ success: true, message: "reboot job queued", job_id: "job-1" });
      }

      // /mcp/tenants/{tid}/registry-credentials   (list + create)
      if (
        url.pathname === `/mcp/tenants/${TENANT_ID}/registry-credentials` ||
        url.pathname === `/mcp/tenants/${TENANT_ID}/registry-credentials/`
      ) {
        if (req.method === "GET") {
          return Response.json([...registryCreds.values()]);
        }
        if (req.method === "POST") {
          const body = (await req.json()) as Record<string, unknown>;
          const id = `cred-${nextId++}`;
          const now = new Date().toISOString();
          const row: Record<string, unknown> = {
            id,
            tenant_id: TENANT_ID,
            name: body["name"],
            registry_type: body["registry_type"],
            registry_url: body["registry_url"],
            username: body["username"] ?? "",
            description: body["description"] ?? "",
            encrypted_credential: "***MASKED***",
            created_at: now,
            updated_at: now,
          };
          registryCreds.set(id, row);
          return Response.json(row);
        }
      }

      // /mcp/tenants/{tid}/registry-credentials/test-connection (POST)
      if (
        url.pathname === `/mcp/tenants/${TENANT_ID}/registry-credentials/test-connection` &&
        req.method === "POST"
      ) {
        const body = (await req.json()) as Record<string, unknown>;
        if (body["registry_url"] === "https://bad.example.com") {
          return Response.json({ success: false, message: "DNS lookup failed", latency_ms: 0 });
        }
        return Response.json({ success: true, message: "ok", latency_ms: 42 });
      }

      // /mcp/tenants/{tid}/registry-credentials/{id}  (get | patch | delete)
      {
        const m = url.pathname.match(/^\/mcp\/tenants\/[^/]+\/registry-credentials\/([^/]+)$/);
        if (m && m[1] !== "test-connection") {
          const id = m[1] ?? "";
          if (req.method === "GET") {
            const row = registryCreds.get(id);
            if (!row) return new Response("not found", { status: 404 });
            return Response.json(row);
          }
          if (req.method === "PATCH") {
            const row = registryCreds.get(id);
            if (!row) return new Response("not found", { status: 404 });
            const body = (await req.json()) as Record<string, unknown>;
            const updated = { ...row, ...body, updated_at: new Date().toISOString() };
            if ("encrypted_credential" in updated) updated["encrypted_credential"] = "***MASKED***";
            registryCreds.set(id, updated);
            return Response.json(updated);
          }
          if (req.method === "DELETE") {
            if (!registryCreds.has(id)) return new Response("not found", { status: 404 });
            registryCreds.delete(id);
            return new Response(null, { status: 204 });
          }
        }
      }

      // /mcp/tenants/{tid}/repositories  (paginated; honors ?search=)
      if (
        url.pathname === `/mcp/tenants/${TENANT_ID}/repositories` ||
        url.pathname === `/mcp/tenants/${TENANT_ID}/repositories/`
      ) {
        const search = url.searchParams.get("search") ?? "";
        const items = search
          ? repositories.filter((r) => r.full_name.includes(search) || r.name.includes(search))
          : repositories;
        return Response.json({ items, total: items.length, skip: 0, limit: items.length });
      }

      // /mcp/tenants/{tid}/repositories/{id}/branches
      {
        const m = url.pathname.match(/^\/mcp\/tenants\/[^/]+\/repositories\/([^/]+)\/branches$/);
        if (m) {
          const branches = repoBranches[m[1] ?? ""];
          if (!branches) return new Response("not found", { status: 404 });
          const defaultBranch = branches.find((b) => b.is_default)?.name ?? "main";
          return Response.json({ branches, default_branch: defaultBranch });
        }
      }

      // /mcp/tenants/{tid}/repositories/{id}
      {
        const m = url.pathname.match(/^\/mcp\/tenants\/[^/]+\/repositories\/([^/]+)$/);
        if (m) {
          const repo = repositories.find((r) => r.id === m[1]);
          if (!repo) return new Response("not found", { status: 404 });
          return Response.json(repo);
        }
      }

      // /mcp/tenants/{tid}/audit-logs   (filtered list)
      if (url.pathname === `/mcp/tenants/${TENANT_ID}/audit-logs`) {
        const actor = url.searchParams.get("actor_id");
        const action = url.searchParams.get("action");
        const resType = url.searchParams.get("resource_type");
        const resId = url.searchParams.get("resource_id");
        const from = url.searchParams.get("from_date");
        const to = url.searchParams.get("to_date");
        const page = Number(url.searchParams.get("page") ?? "1");
        const pageSize = Math.min(Number(url.searchParams.get("page_size") ?? "50"), 200);

        let filtered = auditLogs;
        if (actor) filtered = filtered.filter((l) => l["actor_id"] === actor);
        if (action) filtered = filtered.filter((l) => l["action"] === action);
        if (resType) filtered = filtered.filter((l) => l["resource_type"] === resType);
        if (resId) filtered = filtered.filter((l) => l["resource_id"] === resId);
        if (from) filtered = filtered.filter((l) => String(l["created_at"]) >= from);
        if (to) filtered = filtered.filter((l) => String(l["created_at"]) <= to);

        const start = (page - 1) * pageSize;
        const items = filtered.slice(start, start + pageSize);
        return Response.json({
          items,
          total: filtered.length,
          page,
          page_size: pageSize,
        });
      }

      // /mcp/tenants/{tid}/users?search=<email>
      if (
        url.pathname === `/mcp/tenants/${TENANT_ID}/users` ||
        url.pathname === `/mcp/tenants/${TENANT_ID}/users/`
      ) {
        const search = url.searchParams.get("search") ?? "";
        const items = search ? users.filter((u) => u.email === search) : users;
        return Response.json({ items });
      }

      // /mcp/tenants/{tid}/dashboard/stats
      if (url.pathname === `/mcp/tenants/${TENANT_ID}/dashboard/stats`) {
        return Response.json({
          server_count: 5,
          server_healthy_count: 4,
          server_unhealthy_count: 1,
          application_count: 12,
          application_running_count: 11,
          domain_count: 8,
          domain_healthy_count: 8,
          open_incident_count: 1,
          recent_incidents: [
            { id: "inc-1", title: "API slow", state: "investigating", severity: "minor" },
          ],
          recent_deployments: [{ id: "dep-1", status: "succeeded" }],
          server_health: [{ server_id: "srv-1", status: "healthy" }],
          recent_activity: [
            {
              id: "act-1",
              action: "deploy_succeeded",
              resource_type: "application",
              resource_name: "web",
              actor_email: "a@x.com",
              created_at: "2026-05-19T00:00:00Z",
            },
            {
              id: "act-2",
              action: "update",
              resource_type: "monitor",
              resource_name: "api-monitor",
              actor_email: "b@x.com",
              created_at: "2026-05-18T00:00:00Z",
            },
          ],
          deploy_history: Array.from({ length: 14 }, (_v, i) => ({
            date: `2026-05-${String(6 + i).padStart(2, "0")}`,
            total: (i * 3) % 8,
            succeeded: (i * 3) % 8,
            failed: 0,
          })),
        });
      }

      // /mcp/tenants/{tid}/logs/stats
      if (url.pathname === `/mcp/tenants/${TENANT_ID}/logs/stats`) {
        return Response.json({
          by_level: { debug: 100, info: 1000, warn: 50, error: 20, fatal: 1 },
          by_source_type: { container: 800, system: 300, runner: 71 },
          total: 1171,
          error_count: 21,
          warn_count: 50,
        });
      }

      // /mcp/tenants/{tid}/logs/usage
      if (url.pathname === `/mcp/tenants/${TENANT_ID}/logs/usage`) {
        return Response.json({
          storage_bytes: 1234567890,
          retention_days: 14,
          error_rate: 0.018,
        });
      }

      // /mcp/tenants/{tid}/logs/sources
      if (url.pathname === `/mcp/tenants/${TENANT_ID}/logs/sources`) {
        return Response.json({
          containers: [
            { name: "app-container", image: "myapp:latest", status: "running" },
            { name: "db-container", image: "postgres:15", status: "running" },
          ],
          journal_units: [
            { unit: "kernel", description: "Linux kernel ring buffer" },
            { unit: "docker.service", description: "Docker daemon" },
            { unit: "sshd.service", description: "OpenSSH server" },
          ],
        });
      }

      // /mcp/tenants/{tid}/logs/live
      if (url.pathname === `/mcp/tenants/${TENANT_ID}/logs/live`) {
        return Response.json({
          server_id: url.searchParams.get("server_id") ?? "srv-1",
          server_name: "web-1",
          source_type: url.searchParams.get("source_type") ?? "system",
          source_name: url.searchParams.get("source_name") ?? "kernel",
          entries: [
            { ts: "2026-05-19T10:00:00Z", level: "info", message: "system log line 1" },
            { ts: "2026-05-19T10:00:01Z", level: "warn", message: "system log line 2" },
          ],
          fetched_at: "2026-05-19T10:00:02Z",
        });
      }

      // /mcp/tenants/{tid}/logs   (paginated query)
      if (url.pathname === `/mcp/tenants/${TENANT_ID}/logs`) {
        const search = url.searchParams.get("search");
        const serverId = url.searchParams.get("server_id");
        const sourceType = url.searchParams.get("source_type");
        const level = url.searchParams.get("level");
        const fromDate = url.searchParams.get("from_date");
        const toDate = url.searchParams.get("to_date");
        const page = Number(url.searchParams.get("page") ?? "1");
        const pageSize = Math.min(Number(url.searchParams.get("page_size") ?? "100"), 500);

        let filtered = logEntries;
        if (search) filtered = filtered.filter((l) => String(l["message"]).includes(search));
        if (serverId) filtered = filtered.filter((l) => l["server_id"] === serverId);
        if (sourceType) filtered = filtered.filter((l) => l["source_type"] === sourceType);
        if (level) filtered = filtered.filter((l) => l["level"] === level);
        if (fromDate) filtered = filtered.filter((l) => String(l["ts"]) >= fromDate);
        if (toDate) filtered = filtered.filter((l) => String(l["ts"]) <= toDate);

        const start = (page - 1) * pageSize;
        const items = filtered.slice(start, start + pageSize);
        return Response.json({ items, total: filtered.length, page, page_size: pageSize });
      }

      // /mcp/tenants/{tid}/tunnels/   (list)
      if (url.pathname === `/mcp/tenants/${TENANT_ID}/tunnels/`) {
        return Response.json([]);
      }

      // /mcp/tenants/{tid}/tunnels/{id}   (get by id)
      if (url.pathname.startsWith(`/mcp/tenants/${TENANT_ID}/tunnels/`)) {
        return new Response("not found", { status: 404 });
      }

      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    tenantId: TENANT_ID,
    token: TOKEN,
    automationKey: AUTOMATION_KEY,
    deployRevokes,
    stop: () => {
      void server.stop();
    },
  };
}
