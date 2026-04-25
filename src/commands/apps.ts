// src/commands/apps.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveApp } from "../client/resolve";
import { printList, printObject, resolveFormat } from "../ui/output";
import type { Application, PaginatedResponse } from "../client/types";

function globalOutput(program: Command): string | undefined {
  const opts: Record<string, unknown> = program.opts();
  return typeof opts["output"] === "string" ? opts["output"] : undefined;
}

export function registerApps(program: Command): void {
  const g = program.command("apps").description("manage applications");

  g.command("ls")
    .description("list applications in the tenant")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const res = await ctx.client.get<PaginatedResponse<Application>>(
        `/tenants/${tid}/applications/?limit=200`,
      );
      printList(
        res.items as unknown as Array<Record<string, unknown>>,
        [
          { key: "slug", label: "SLUG" },
          { key: "name", label: "NAME" },
          { key: "server_id", label: "SERVER" },
          { key: "current_deployment_id", label: "DEPLOYMENT" },
        ],
        fmt,
      );
    });

  g.command("get <idOrSlug>")
    .description("show details for one application")
    .action(async (idOrSlug: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const id = await resolveApp(ctx.client, tid, idOrSlug);
      const app = await ctx.client.get<Application>(`/tenants/${tid}/applications/${id}`);
      printObject(app as unknown as Record<string, unknown>, fmt);
    });

  g.command("deploy <idOrSlug>")
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

  g.command("logs <idOrSlug>")
    .description("fetch container logs for an application")
    .option("--tail <n>", "number of lines to return", "200")
    .option("--search <term>", "substring filter applied server-side")
    .option("--since <ts>", "RFC 3339 timestamp; only return lines after this time")
    .action(
      async (
        idOrSlug: string,
        opts: { tail?: string; search?: string; since?: string },
      ) => {
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
    );

  g.command("restart <idOrSlug>")
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
    });
}
