// src/commands/builds.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { requireCapability, withCompletion } from "../client/command-meta";
import { BUILD_STATUSES } from "../client/enums";
import { resolveApp } from "../client/resolve";
import type { Application, PaginatedResponse } from "../client/types";
import { globalOutput, printList, printMutation, printObject, resolveFormat } from "../ui/output";
import { parseEnum } from "../util/parse-flag";
import { parseLimit, parseOffset } from "../util/parse-limit";

const HARD_LIMIT = 100;
const SHORT_SHA = 7;

interface Build {
  id: string;
  application_id: string;
  status: string;
  pool_id: string;
  commit_sha: string;
  created_at: string;
  duration_seconds: number | null;
  queue_position: number | null;
}

export function registerBuilds(program: Command): void {
  const g = program.command("builds").description("build history on build servers");

  withCompletion(
    g
      .command("ls")
      .description("list builds (--status filters the fetched page)")
      .option("--app <idOrSlug>", "filter by application")
      .option("--status <status>", `filter by status: ${BUILD_STATUSES.join(", ")}`)
      .option("--skip <n>", "pagination skip", "0")
      .option("--limit <n>", "pagination limit", "20")
      .action(async (opts: { app?: string; status?: string; skip: string; limit: string }) => {
        const status =
          opts.status === undefined ? undefined : parseEnum(opts.status, BUILD_STATUSES, "--status");
        const skip = parseOffset(opts.skip);
        const limit = parseLimit(opts.limit, HARD_LIMIT);
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const params = new URLSearchParams({ skip: String(skip), limit: String(limit) });
        if (opts.app !== undefined) {
          params.set("application_id", await resolveApp(ctx.client, tid, opts.app));
        }
        const [res, apps] = await Promise.all([
          ctx.client.get<PaginatedResponse<Build>>(`/tenants/${tid}/builds/?${params.toString()}`),
          // Best-effort sidecar so the APP column shows a slug instead of a UUID.
          ctx.client
            .get<PaginatedResponse<Application>>(`/tenants/${tid}/applications/?limit=200`)
            .then((r) => r.items)
            .catch(() => [] as Application[]),
        ]);
        const slugById = new Map(apps.map((a) => [a.id, a.slug] as const));
        const rows = res.items
          .filter((b) => status === undefined || b.status === status)
          .map((b) => ({
            ...b,
            app_slug: slugById.get(b.application_id) ?? b.application_id,
            commit_short: b.commit_sha.slice(0, SHORT_SHA),
            duration: b.duration_seconds === null ? "" : `${b.duration_seconds}s`,
          }));
        printList(
          rows as unknown as Array<Record<string, unknown>>,
          [
            { key: "id", label: "ID" },
            { key: "app_slug", label: "APP" },
            { key: "status", label: "STATUS" },
            { key: "queue_position", label: "QUEUE" },
            { key: "commit_short", label: "COMMIT" },
            { key: "created_at", label: "CREATED" },
            { key: "duration", label: "DURATION" },
          ],
          fmt,
        );
      }),
    { flags: { "--app": "apps", "--status": { enum: [...BUILD_STATUSES] } } },
  );

  g.command("get <id>")
    .description("show one build")
    .action(async (id: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const build = await ctx.client.get<Build>(`/tenants/${tid}/builds/${id}`);
      printObject(build as unknown as Record<string, unknown>, fmt);
    });

  g.command("logs <id>")
    .description("show a build's log tail")
    .action(async (id: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const res = await ctx.client.get<{ lines: string[] }>(`/tenants/${tid}/builds/${id}/logs`);
      if (fmt === "json" || fmt === "yaml") {
        printObject(res, fmt);
        return;
      }
      for (const line of res.lines) process.stdout.write(`${line}\n`);
    });

  const cancelCmd = g.command("cancel <id>");
  requireCapability(cancelCmd, "app:deploy");
  cancelCmd
    .description("cancel a queued or running build (the builder stops asynchronously)")
    .action(async (id: string) => {
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const build = await ctx.client.post<Build>(`/tenants/${tid}/builds/${id}/cancel`);
      printMutation(
        program,
        build as unknown as Record<string, unknown>,
        `✓ cancel requested: ${build.id} (status: ${build.status})`,
      );
    });
}
