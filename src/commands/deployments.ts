// src/commands/deployments.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveApp } from "../client/resolve";
import { printList, printObject, resolveFormat } from "../ui/output";
import type { Deployment } from "../client/types";

function globalOutput(program: Command): string | undefined {
  const opts: Record<string, unknown> = program.opts();
  return typeof opts["output"] === "string" ? opts["output"] : undefined;
}

interface DeploymentStageDetail {
  name?: string;
  status?: string;
  log_tail?: string[];
  error_message?: string | null;
  duration_ms?: number | null;
  [k: string]: unknown;
}

interface DeploymentWithStages extends Deployment {
  stages?: DeploymentStageDetail[];
  build_log_tail?: string[];
}

interface PaginatedDeployments {
  items: Array<Record<string, unknown>>;
  total: number;
  skip: number;
  limit: number;
}

export function registerDeployments(program: Command): void {
  const g = program.command("deployments").description("deployment history");

  g.command("ls")
    .description("list deployments for the tenant")
    .option("--app <idOrSlug>", "filter by application")
    .option("--skip <n>", "pagination skip", "0")
    .option("--limit <n>", "pagination limit", "20")
    .action(async (opts: { app?: string; skip?: string; limit?: string }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const params = new URLSearchParams();
      if (opts.skip) params.set("skip", opts.skip);
      if (opts.limit) params.set("limit", opts.limit);
      if (opts.app) {
        const appId = await resolveApp(ctx.client, tid, opts.app);
        params.set("application_id", appId);
      }
      const qs = params.toString();
      const path = `/tenants/${tid}/deployments/${qs ? `?${qs}` : ""}`;
      const res = await ctx.client.get<PaginatedDeployments>(path);
      printList(
        res.items,
        [
          { key: "id", label: "ID" },
          { key: "application_name", label: "APP" },
          { key: "deployment_number", label: "#" },
          { key: "status", label: "STATUS" },
          { key: "commit_sha", label: "COMMIT" },
          { key: "started_at", label: "STARTED" },
        ],
        fmt,
      );
    });

  g.command("get <id>")
    .description("show full deployment details (including build stages)")
    .requiredOption("--app <idOrSlug>", "application the deployment belongs to")
    .action(async (id: string, opts: { app: string }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const appId = await resolveApp(ctx.client, tid, opts.app);
      const dep = await ctx.client.get<DeploymentWithStages>(
        `/tenants/${tid}/applications/${appId}/deployments/${id}`,
      );
      printObject(dep as unknown as Record<string, unknown>, fmt);
    });

  g.command("logs <id>")
    .description("show deployment build stage logs (--build) or runtime logs (--runtime, not yet available)")
    .option("--build", "show build stage logs (concatenated by stage)")
    .option("--runtime", "show runtime logs (not yet available)")
    .requiredOption("--app <idOrSlug>", "application the deployment belongs to")
    .action(async (id: string, opts: { build?: boolean; runtime?: boolean; app: string }) => {
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);

      if (opts.runtime) {
        process.stderr.write(
          "runtime logs are not yet available via this endpoint; use the dashboard or check container logs\n",
        );
        process.exit(1);
      }

      // Default: build stage logs (also explicit --build)
      const appId = await resolveApp(ctx.client, tid, opts.app);
      const dep = await ctx.client.get<DeploymentWithStages>(
        `/tenants/${tid}/applications/${appId}/deployments/${id}`,
      );
      const stages = dep.stages ?? [];
      if (stages.length === 0) {
        process.stderr.write("no build stages found for this deployment\n");
        process.exit(0);
      }
      for (const stage of stages) {
        process.stdout.write(`=== ${stage.name ?? "stage"} (${stage.status ?? "?"}) ===\n`);
        const lines = stage.log_tail ?? [];
        for (const line of lines) {
          process.stdout.write(line + "\n");
        }
        if (stage.error_message) {
          process.stdout.write(`ERROR: ${stage.error_message}\n`);
        }
      }
    });
}
