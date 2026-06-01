// src/commands/apps.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveApp } from "../client/resolve";
import { globalOutput, printList, printMutation, printObject, resolveFormat } from "../ui/output";
import type { Application, PaginatedResponse } from "../client/types";
import { requireCapability, withCompletion } from "../client/command-meta";
import { cacheList } from "../completion/populate";
import { parseSetFlags } from "../util/parse-set";


export function registerApps(program: Command): void {
  const g = program.command("apps").description("manage applications");

  g.command("ls")
    .description("list applications in the organization")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const [appsRes, servers] = await Promise.all([
        ctx.client.get<PaginatedResponse<Application>>(
          `/tenants/${tid}/applications/?limit=200`,
        ),
        // Best-effort sidecar fetch so the SERVER column shows a slug instead
        // of the UUID. Falls back to "" if the fetch fails for any reason.
        ctx.client
          .get<Array<{ id: string; slug: string }>>(`/tenants/${tid}/servers/`)
          .catch(() => [] as Array<{ id: string; slug: string }>),
      ]);
      cacheList("apps", appsRes.items);
      const serverSlugById = new Map(servers.map((s) => [s.id, s.slug] as const));
      const rows = appsRes.items.map((a) => ({
        ...a,
        server_slug: serverSlugById.get(a.server_id ?? "") ?? (a.server_id ?? ""),
      }));
      printList(
        rows as unknown as Array<Record<string, unknown>>,
        [
          { key: "slug", label: "SLUG" },
          { key: "name", label: "NAME" },
          { key: "server_slug", label: "SERVER" },
          { key: "current_deployment_id", label: "DEPLOYMENT" },
        ],
        fmt,
      );
      if (fmt === "text" && appsRes.items.length === 0) {
        process.stderr.write(
          "note: no Reoclo-managed applications. 'apps' / 'deployments' track apps deployed " +
            "through Reoclo — not raw Docker Swarm services. Use 'reoclo containers ls' to see " +
            "running containers/services.\n",
        );
      }
    });

  withCompletion(
    g
      .command("get <idOrSlug>")
      .description("show details for one application")
      .action(async (idOrSlug: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const id = await resolveApp(ctx.client, tid, idOrSlug);
        const app = await ctx.client.get<Application>(`/tenants/${tid}/applications/${id}`);
        printObject(app as unknown as Record<string, unknown>, fmt);
      }),
    { args: [{ slot: 0, resource: "apps" }] },
  );

  const deployCmd = withCompletion(g.command("deploy <idOrSlug>"), {
    args: [{ slot: 0, resource: "apps" }],
  });
  requireCapability(deployCmd, "app:deploy");
  deployCmd
    .description("trigger a deployment for an application")
    .option("--ref <git-ref>", "branch, tag, or SHA to deploy")
    .option("--wait", "wait for the deployment to finish (poll status every 3s)")
    .action(async (idOrSlug: string, opts: { ref?: string; wait?: boolean }) => {
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const appId = await resolveApp(ctx.client, tid, idOrSlug);

      const body: Record<string, unknown> = {};
      if (opts.ref) body["commit_ref"] = opts.ref;

      interface DeployResponse {
        id: string;
        status?: string;
      }
      const dep = await ctx.client.post<DeployResponse>(
        `/tenants/${tid}/applications/${appId}/deploy`,
        body,
      );
      console.log(`✓ deployment ${dep.id} queued (status: ${dep.status ?? "?"})`);

      if (!opts.wait) return;

      let done = false;
      const start = Date.now();
      while (!done) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const cur = await ctx.client.get<{ status: string }>(
          `/tenants/${tid}/applications/${appId}/deployments/${dep.id}`,
        );
        const elapsed = Math.round((Date.now() - start) / 1000);
        process.stdout.write(`\r  status: ${cur.status}   (${elapsed}s)        `);
        if (cur.status === "succeeded") {
          process.stdout.write("\n✓ succeeded\n");
          done = true;
        } else if (cur.status === "failed" || cur.status === "cancelled") {
          process.stdout.write(`\n✗ ${cur.status}\n`);
          process.exit(1);
        }
      }
    });

  withCompletion(
    g
      .command("logs <idOrSlug>")
      .description("fetch container logs for an application")
      .option("--tail <n>", "number of lines to return", "200")
      .option("--search <term>", "substring filter applied server-side")
      .option("--since <ts>", "RFC 3339 timestamp; only return lines after this time")
      .action(
        async (idOrSlug: string, opts: { tail?: string; search?: string; since?: string }) => {
          const fmt = resolveFormat(globalOutput(program));
          const ctx = await bootstrap();
          const tid = requireTenantId(ctx);
          const appId = await resolveApp(ctx.client, tid, idOrSlug);

          const qs = new URLSearchParams();
          if (opts.tail) qs.set("tail", opts.tail);
          if (opts.search) qs.set("search", opts.search);
          if (opts.since) qs.set("since", opts.since);
          const suffix = qs.toString() ? `?${qs.toString()}` : "";

          interface LogEntry {
            timestamp?: string;
            level?: string;
            message: string;
          }
          interface LiveLogResponse {
            entries: LogEntry[];
            server_id: string;
            source_name: string;
          }
          const res = await ctx.client.get<LiveLogResponse>(
            `/tenants/${tid}/applications/${appId}/logs${suffix}`,
          );

          if (fmt === "json" || fmt === "yaml") {
            printObject(res as unknown as Record<string, unknown>, fmt);
            return;
          }
          for (const e of res.entries) {
            const ts = e.timestamp ?? "";
            const lvl = e.level ? `[${e.level}] ` : "";
            process.stdout.write(`${ts} ${lvl}${e.message}\n`);
          }
        },
      ),
    { args: [{ slot: 0, resource: "apps" }] },
  );

  withCompletion(
    g
      .command("restart <idOrSlug>")
      .description("restart the container backing an application")
      .action(async (idOrSlug: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const appId = await resolveApp(ctx.client, tid, idOrSlug);

        interface RestartResponse {
          application_id: string;
          container_name: string;
          exit_code: number;
          stdout: string;
          stderr: string;
        }
        const res = await ctx.client.post<RestartResponse>(
          `/tenants/${tid}/applications/${appId}/restart`,
          {},
        );

        if (fmt === "json" || fmt === "yaml") {
          printObject(res as unknown as Record<string, unknown>, fmt);
          return;
        }
        if (res.exit_code === 0) {
          console.log(`✓ restarted ${res.container_name}`);
        } else {
          process.stderr.write(
            `✗ restart of ${res.container_name} failed (exit ${res.exit_code})\n`,
          );
          if (res.stderr) process.stderr.write(`  ${res.stderr.trim()}\n`);
          const err = new Error("restart failed") as Error & { exitCode: number };
          err.exitCode = 1;
          throw err;
        }
      }),
    { args: [{ slot: 0, resource: "apps" }] },
  );

  const configCmd = g.command("config").description("manage application deployment config");

  withCompletion(
    configCmd
      .command("get <idOrSlug>")
      .description("show app deployment config (build + deploy settings)")
      .action(async (idOrSlug: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const aid = await resolveApp(ctx.client, tid, idOrSlug);
        const r = await ctx.client.get<Record<string, unknown>>(
          `/tenants/${tid}/applications/${aid}/config`,
        );
        printObject(r, fmt);
      }),
    { args: [{ slot: 0, resource: "apps" }] },
  );

  withCompletion(
    configCmd
      .command("set <idOrSlug>")
      .description("update app deployment config")
      .option("--buildpack <name>", "buildpack name")
      .option("--docker-image <ref>", "docker image reference")
      .option("--container-port <n>", "container port (numeric)")
      .option("--host-port <n>", "host port (numeric)")
      .option("--replicas <n>", "replica count (numeric)")
      .option(
        "--env <KEY=VAL>",
        "env var (repeatable)",
        (val: string, prev?: string[]) => [...(prev ?? []), val],
      )
      .option(
        "--set <KEY=VAL>",
        "set arbitrary field (dot-paths supported; repeatable)",
        (val: string, prev?: string[]) => [...(prev ?? []), val],
      )
      .action(
        async (
          idOrSlug: string,
          opts: {
            buildpack?: string;
            dockerImage?: string;
            containerPort?: string;
            hostPort?: string;
            replicas?: string;
            env?: string[];
            set?: string[];
          },
        ) => {
          const ctx = await bootstrap();
          const tid = requireTenantId(ctx);
          const aid = await resolveApp(ctx.client, tid, idOrSlug);

          // Start with --set first (typed flags overwrite on conflict).
          const cfg: Record<string, unknown> = parseSetFlags(opts.set ?? []);

          function setPath(path: string[], value: unknown): void {
            let cur: Record<string, unknown> = cfg;
            for (let i = 0; i < path.length - 1; i++) {
              const segment = path[i] as string;
              const next = cur[segment];
              if (typeof next !== "object" || next === null || Array.isArray(next)) {
                cur[segment] = {};
              }
              cur = cur[segment] as Record<string, unknown>;
            }
            cur[path[path.length - 1] as string] = value;
          }

          if (opts.buildpack !== undefined) setPath(["build", "buildpack"], opts.buildpack);
          if (opts.dockerImage !== undefined) setPath(["build", "docker_image"], opts.dockerImage);
          if (opts.containerPort !== undefined)
            setPath(["deploy", "container_port"], Number(opts.containerPort));
          if (opts.hostPort !== undefined)
            setPath(["deploy", "host_port"], Number(opts.hostPort));
          if (opts.replicas !== undefined)
            setPath(["deploy", "replicas"], Number(opts.replicas));
          if (opts.env && opts.env.length > 0) {
            const envMap: Record<string, string> = {};
            for (const kv of opts.env) {
              const eq = kv.indexOf("=");
              if (eq === -1) {
                const e = new Error(
                  `invalid --env value: '${kv}' (expected KEY=VAL)`,
                ) as Error & { exitCode: number };
                e.exitCode = 4;
                throw e;
              }
              envMap[kv.slice(0, eq)] = kv.slice(eq + 1);
            }
            const existing = (cfg["deploy"] as Record<string, unknown> | undefined)?.["env"];
            const merged = {
              ...(typeof existing === "object" && existing !== null
                ? (existing as Record<string, string>)
                : {}),
              ...envMap,
            };
            setPath(["deploy", "env"], merged);
          }

          if (Object.keys(cfg).length === 0) {
            const e = new Error("no fields to update") as Error & { exitCode: number };
            e.exitCode = 4;
            throw e;
          }

          const r = await ctx.client.patch<Record<string, unknown>>(
            `/tenants/${tid}/applications/${aid}/config`,
            { config: cfg },
          );
          printMutation(program, r, `✓ config updated: ${aid}`);
        },
      ),
    { args: [{ slot: 0, resource: "apps" }] },
  );
}
