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
  }> = [];
  const deployments: Array<{ id: string; status: string }> = [];
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
