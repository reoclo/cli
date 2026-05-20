// src/commands/deployments.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveApp } from "../client/resolve";
import { globalOutput, printList, printObject, resolveFormat } from "../ui/output";
import type { Deployment } from "../client/types";
import { withCompletion } from "../client/command-meta";
import { cacheList } from "../completion/populate";
import { parseLimit, parseOffset } from "../util/parse-limit";

const HARD_LIMIT = 1000;

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

  withCompletion(
    g
      .command("ls")
      .description("list deployments for the organization")
      .option("--app <idOrSlug>", "filter by application")
      .option("--skip <n>", "pagination skip", "0")
      .option("--limit <n>", "pagination limit", "20")
      .action(async (opts: { app?: string; skip?: string; limit?: string }) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const skip = parseOffset(opts.skip ?? "0");
        const limit = parseLimit(opts.limit ?? "20", HARD_LIMIT);
        const params = new URLSearchParams();
        params.set("skip", String(skip));
        params.set("limit", String(limit));
        if (opts.app) {
          const appId = await resolveApp(ctx.client, tid, opts.app);
          params.set("application_id", appId);
        }
        const qs = params.toString();
        const path = `/tenants/${tid}/deployments/${qs ? `?${qs}` : ""}`;
        const res = await ctx.client.get<PaginatedDeployments>(path);
        cacheList("deployments", res.items);
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
      }),
    { flags: { "--app": "apps" } },
  );

  withCompletion(
    g
      .command("get <id>")
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
      }),
    { args: [{ slot: 0, resource: "deployments" }], flags: { "--app": "apps" } },
  );

  withCompletion(
    g
      .command("logs <id>")
      .description(
        "show deployment build stage logs (--build) or runtime logs (--runtime, not yet available)",
      )
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
      }),
    { args: [{ slot: 0, resource: "deployments" }], flags: { "--app": "apps" } },
  );

  interface DeploymentStage {
    name: string;
    status: string;
    started_at?: string | null;
    ended_at?: string | null;
    exit_code?: number | null;
  }

  function formatDuration(start?: string | null, end?: string | null): string {
    if (!start || !end) return "";
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (!Number.isFinite(ms) || ms < 0) return "";
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h${m}m`;
    if (m > 0) return `${m}m${s}s`;
    return `${s}s`;
  }

  withCompletion(
    g
      .command("stages <id>")
      .description("show deployment pipeline stages (build/push/deploy)")
      .action(async (id: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const stages = await ctx.client.get<DeploymentStage[]>(
          `/tenants/${tid}/deployments/${id}/stages`,
        );

        if (fmt === "json" || fmt === "yaml") {
          for (const stage of stages) {
            printObject(stage as unknown as Record<string, unknown>, fmt);
          }
          return;
        }

        const rows = stages.map((s) => ({
          stage: s.name,
          status: s.status,
          started: s.started_at ? s.started_at.replace("T", " ").replace("Z", "") : "",
          duration: formatDuration(s.started_at, s.ended_at),
          exit: s.exit_code == null ? "" : String(s.exit_code),
        }));
        printList(
          rows as unknown as Array<Record<string, unknown>>,
          [
            { key: "stage", label: "STAGE" },
            { key: "status", label: "STATUS" },
            { key: "started", label: "STARTED" },
            { key: "duration", label: "DURATION" },
            { key: "exit", label: "EXIT" },
          ],
          fmt,
        );
      }),
    { args: [{ slot: 0, resource: "deployments" }] },
  );
}
