// src/commands/groups.ts
//
// Definition groups (stacks): the observability surface that the 2026-08-17
// EnvDev incident showed was missing from the CLI — list stacks, read group
// deployments with their stages and per-service slices, trigger Deploy All,
// and redeploy a single service. Mirrors the web UI's group surfaces over the
// same /tenants/{tid}/application-groups API.

import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { requireCapability } from "../client/command-meta";
import { globalOutput, printList, printObject, resolveFormat } from "../ui/output";
import { parseLimit } from "../util/parse-limit";

export interface GroupRead {
  id: string;
  name: string;
  slug: string;
  kind: string;
  server_id: string;
  auto_deploy?: boolean;
  compose_file_path?: string | null;
  application_count?: number;
  latest_deployment?: {
    id: string;
    deployment_number: number;
    status: string;
    created_at?: string;
  } | null;
  [k: string]: unknown;
}

export interface GroupStage {
  name?: string;
  status?: string;
  duration_ms?: number | null;
  error_message?: string | null;
  log_tail?: string[];
}

export interface GroupServiceSlice {
  application_id?: string;
  compose_service?: string;
  deployment_id?: string | null;
  planned_action?: string;
  reason?: string;
  status?: string;
}

export interface GroupDeploymentRead {
  id: string;
  deployment_number: number;
  status: string;
  trigger?: string;
  commit_sha?: string | null;
  commit_ref?: string | null;
  created_at?: string;
  duration_seconds?: number | null;
  error_message?: string | null;
  stages?: GroupStage[];
  services?: GroupServiceSlice[];
  [k: string]: unknown;
}

interface PaginatedGroupDeployments {
  items: GroupDeploymentRead[];
  total: number;
}

export interface GroupTaskRunRead {
  id: string;
  compose_service?: string;
  status: string;
  exit_code?: number | null;
  created_at?: string;
  duration_seconds?: number | null;
  error_message?: string | null;
  log_tail?: string[];
  [k: string]: unknown;
}

interface PaginatedGroupTaskRuns {
  items: GroupTaskRunRead[];
  total: number;
}

export const TERMINAL_TASK_RUN_STATUSES = new Set(["succeeded", "failed"]);

export function taskRunSummary(run: GroupTaskRunRead): Record<string, unknown> {
  return {
    id: run.id.slice(0, 8),
    service: run.compose_service ?? "",
    status: run.status,
    exit: run.exit_code ?? "",
    started: (run.created_at ?? "").replace("T", " ").slice(0, 19),
    duration: fmtDurationS(run.duration_seconds),
    error: run.error_message ?? "",
  };
}

export interface MemberApp {
  id: string;
  slug?: string;
  group_id?: string | null;
  build?: { compose_service?: string | null } | null;
  [k: string]: unknown;
}

export const TERMINAL_GROUP_STATUSES = new Set(["succeeded", "failed", "partial", "cancelled"]);

export function matchGroup(groups: GroupRead[], ref: string): GroupRead | undefined {
  return groups.find((g) => g.id === ref || g.slug === ref);
}

export interface DetailMember {
  slug?: string;
  compose_service?: string | null;
  status?: string;
  managed_by_group?: boolean;
  orphaned_from_definition?: boolean;
  [k: string]: unknown;
}

/** Members whose compose service left the definition (REO-376). Mirrors the
 *  prune endpoint's own selection (managed members only), so the dry-run
 *  listing never promises a removal the server will skip. */
export function orphanedMembers<T extends DetailMember>(apps: T[]): T[] {
  return apps.filter((a) => a.orphaned_from_definition === true && a.managed_by_group === true);
}

export function matchGroupDeployment(
  items: GroupDeploymentRead[],
  ref: string,
): GroupDeploymentRead | undefined {
  const byId = items.find((d) => d.id === ref);
  if (byId) return byId;
  const n = Number(ref);
  if (!Number.isInteger(n)) return undefined;
  return items.find((d) => d.deployment_number === n);
}

export function memberForService(
  apps: MemberApp[],
  groupId: string,
  service: string,
): MemberApp | undefined {
  return apps.find((a) => a.group_id === groupId && a.build?.compose_service === service);
}

export function fmtDurationMs(ms?: number | null): string {
  if (ms === undefined || ms === null) return "";
  return fmtDurationS(ms / 1000);
}

export function fmtDurationS(seconds?: number | null): string {
  if (seconds === undefined || seconds === null) return "";
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m${s}s`;
}

export function stageRows(stages: GroupStage[]): Array<Record<string, unknown>> {
  return stages.map((s) => ({
    stage: s.name ?? "",
    status: s.status ?? "",
    duration: fmtDurationMs(s.duration_ms),
    error: s.error_message ?? "",
  }));
}

export function serviceRows(services: GroupServiceSlice[]): Array<Record<string, unknown>> {
  return services.map((s) => ({
    service: s.compose_service ?? "",
    action: s.planned_action ?? "",
    status: s.status ?? "",
    reason: s.reason ?? "",
    deployment: s.deployment_id ?? "",
  }));
}

async function resolveGroup(
  get: <T>(path: string) => Promise<T>,
  tid: string,
  ref: string,
): Promise<GroupRead> {
  const groups = await get<GroupRead[]>(`/tenants/${tid}/application-groups/`);
  const found = matchGroup(groups, ref);
  if (!found) {
    const CAP = 10;
    let message = `group '${ref}' not found`;
    if (groups.length > 0) {
      const shown = groups.slice(0, CAP).map((g) => g.slug);
      const remainder = groups.length - shown.length;
      message += `. available: ${shown.join(", ")}`;
      if (remainder > 0) message += ` (+${remainder} more)`;
    }
    const e = new Error(message) as Error & { exitCode: number };
    e.exitCode = 5;
    throw e;
  }
  return found;
}

function deploymentSummary(d: GroupDeploymentRead): Record<string, unknown> {
  return {
    n: d.deployment_number,
    status: d.status,
    trigger: d.trigger ?? "",
    sha: (d.commit_sha ?? "").slice(0, 8),
    started: (d.created_at ?? "").replace("T", " ").slice(0, 19),
    duration: fmtDurationS(d.duration_seconds),
    error: d.error_message ?? "",
  };
}

export function registerGroups(program: Command): void {
  const g = program
    .command("groups")
    .alias("stacks")
    .description("definition groups (stacks): coordinated compose deployments");

  g.command("ls")
    .description("list definition groups")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const groups = await ctx.client.get<GroupRead[]>(`/tenants/${tid}/application-groups/`);
      const rows = groups.map((r) => ({
        slug: r.slug,
        name: r.name,
        kind: r.kind,
        apps: r.application_count ?? "",
        ci: (r as { require_ci?: boolean }).require_ci ? "on" : "off",
        "last deploy": r.latest_deployment
          ? `#${r.latest_deployment.deployment_number} ${r.latest_deployment.status}`
          : "",
      }));
      printList(
        rows as unknown as Array<Record<string, unknown>>,
        [
          { key: "slug", label: "SLUG" },
          { key: "name", label: "NAME" },
          { key: "kind", label: "KIND" },
          { key: "apps", label: "APPS" },
          { key: "ci", label: "CI" },
          { key: "last deploy", label: "LAST DEPLOY" },
        ],
        fmt,
      );
    });

  g.command("get <group>")
    .description("show one definition group (id or slug)")
    .action(async (ref: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const group = await resolveGroup(ctx.client.get.bind(ctx.client), tid, ref);
      printObject(group, fmt);
    });

  // No requireCapability: the endpoint needs the applications:delete
  // permission, which no capability verb maps to — a local app:deploy gate
  // would pass keys the server rejects and block roles the server allows.
  g.command("prune <group>")
    .description("remove members whose service left the compose definition (REO-376)")
    .option("--yes", "confirm removal; without it, prune only lists the orphans")
    .action(async (ref: string, opts: { yes?: boolean }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const group = await resolveGroup(ctx.client.get.bind(ctx.client), tid, ref);
      if (opts.yes) {
        // The server selects the orphans authoritatively; no client preview.
        const result = await ctx.client.post<{ removed: string[] }>(
          `/tenants/${tid}/application-groups/${group.id}/prune`,
        );
        if (fmt !== "text") {
          printObject(result, fmt);
        } else if (result.removed.length === 0) {
          console.log("No orphaned members to prune.");
        } else {
          for (const slug of result.removed) console.log(`✓ removed ${slug}`);
        }
        return;
      }
      const detail = await ctx.client.get<GroupRead & { applications?: DetailMember[] }>(
        `/tenants/${tid}/application-groups/${group.id}`,
      );
      const orphans = orphanedMembers(detail.applications ?? []);
      if (orphans.length === 0) {
        if (fmt !== "text") printObject({ orphaned: [] }, fmt);
        else console.log("No orphaned members to prune.");
        return;
      }
      printList(
        orphans.map((o) => ({
          slug: o.slug ?? "",
          service: o.compose_service ?? "",
          status: o.status ?? "",
        })),
        [
          { key: "slug", label: "SLUG" },
          { key: "service", label: "SERVICE" },
          { key: "status", label: "STATUS" },
        ],
        fmt,
      );
      if (fmt === "text") {
        console.log(`Re-run with --yes to remove ${orphans.length} orphaned member(s).`);
      }
    });

  g.command("deployments <group>")
    .description("list group deployments (newest first)")
    .option("--limit <n>", "max rows (default 20)", "20")
    .action(async (ref: string, opts: { limit: string }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const group = await resolveGroup(ctx.client.get.bind(ctx.client), tid, ref);
      const limit = parseLimit(opts.limit, 200);
      const res = await ctx.client.get<PaginatedGroupDeployments>(
        `/tenants/${tid}/application-groups/${group.id}/deployments?limit=${limit}`,
      );
      printList(
        res.items.map(deploymentSummary),
        [
          { key: "n", label: "N" },
          { key: "status", label: "STATUS" },
          { key: "trigger", label: "TRIGGER" },
          { key: "sha", label: "SHA" },
          { key: "started", label: "STARTED" },
          { key: "duration", label: "DURATION" },
          { key: "error", label: "ERROR" },
        ],
        fmt,
      );
    });

  g.command("deployment <group> <numberOrId>")
    .description("show one group deployment: stages and per-service slices")
    .option("--logs", "also print each stage's captured log tail")
    .action(async (ref: string, dref: string, opts: { logs?: boolean }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const group = await resolveGroup(ctx.client.get.bind(ctx.client), tid, ref);
      const base = `/tenants/${tid}/application-groups/${group.id}/deployments`;
      const res = await ctx.client.get<PaginatedGroupDeployments>(`${base}?limit=100`);
      const found = matchGroupDeployment(res.items, dref);
      if (!found) {
        const e = new Error(
          `deployment '${dref}' not found in group '${group.slug}' (latest: #${
            res.items[0]?.deployment_number ?? "none"
          })`,
        ) as Error & { exitCode: number };
        e.exitCode = 5;
        throw e;
      }
      const detail = await ctx.client.get<GroupDeploymentRead>(`${base}/${found.id}`);

      if (fmt !== "text") {
        printObject(detail, fmt);
        return;
      }
      printObject(
        {
          id: detail.id,
          n: detail.deployment_number,
          status: detail.status,
          trigger: detail.trigger ?? "",
          commit: `${detail.commit_ref ?? ""}@${(detail.commit_sha ?? "").slice(0, 8)}`,
          started: detail.created_at ?? "",
          duration: fmtDurationS(detail.duration_seconds),
          error: detail.error_message ?? "",
        },
        fmt,
      );
      const stages = detail.stages ?? [];
      if (stages.length > 0) {
        console.log("");
        printList(
          stageRows(stages),
          [
            { key: "stage", label: "STAGE" },
            { key: "status", label: "STATUS" },
            { key: "duration", label: "DURATION" },
            { key: "error", label: "ERROR" },
          ],
          fmt,
        );
      }
      const services = detail.services ?? [];
      if (services.length > 0) {
        console.log("");
        printList(
          serviceRows(services),
          [
            { key: "service", label: "SERVICE" },
            { key: "action", label: "ACTION" },
            { key: "status", label: "STATUS" },
            { key: "reason", label: "REASON" },
            { key: "deployment", label: "DEPLOYMENT" },
          ],
          fmt,
        );
      }
      if (opts.logs) {
        for (const s of stages) {
          const tail = s.log_tail ?? [];
          if (tail.length === 0) continue;
          console.log(`\n── ${s.name} ──`);
          for (const line of tail) console.log(line);
        }
      }
    });

  const deployCmd = g
    .command("deploy <group>")
    .description("trigger a coordinated deployment of every managed member (Deploy All)")
    .option(
      "--force-recreate",
      "recreate containers even when the image and configuration did not change",
    )
    .option("--wait", "poll until the group deployment reaches a terminal status")
    .option("--wait-timeout <seconds>", "give up waiting after this long (default 600)", "600")
    .action(
      async (
        ref: string,
        opts: { forceRecreate?: boolean; wait?: boolean; waitTimeout: string },
      ) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const group = await resolveGroup(ctx.client.get.bind(ctx.client), tid, ref);
        const result = await ctx.client.post<{
          total: number;
          triggered: number;
          skipped: number;
          group_deployment_id?: string | null;
        }>(
          `/tenants/${tid}/application-groups/${group.id}/deploy`,
          opts.forceRecreate ? { force_recreate: true } : undefined,
        );
        printObject(result, fmt);

        const gdId = result.group_deployment_id;
        if (!opts.wait || !gdId) return;

        const timeoutMs = Number(opts.waitTimeout) * 1000;
        const startedAt = Date.now();
        const seen = new Map<string, string>();
        const base = `/tenants/${tid}/application-groups/${group.id}/deployments/${gdId}`;
        for (;;) {
          if (Date.now() - startedAt > timeoutMs) {
            const e = new Error(
              `timed out after ${opts.waitTimeout}s waiting for group deployment ${gdId}`,
            ) as Error & { exitCode: number };
            e.exitCode = 12;
            throw e;
          }
          await new Promise((r) => setTimeout(r, 5000));
          const d = await ctx.client.get<GroupDeploymentRead>(base);
          for (const s of d.stages ?? []) {
            const name = s.name ?? "";
            const status = s.status ?? "";
            if (name && seen.get(name) !== status) {
              seen.set(name, status);
              if (fmt === "text") {
                const dur = s.duration_ms ? ` (${fmtDurationMs(s.duration_ms)})` : "";
                console.log(`stage ${name}: ${status}${dur}`);
              }
            }
          }
          if (TERMINAL_GROUP_STATUSES.has(d.status)) {
            if (fmt === "text") {
              console.log(`deployment #${d.deployment_number}: ${d.status}`);
            } else {
              printObject(d, fmt);
            }
            if (d.status !== "succeeded") {
              const e = new Error(
                d.error_message ?? `group deployment finished ${d.status}`,
              ) as Error & { exitCode: number };
              e.exitCode = 1;
              throw e;
            }
            return;
          }
        }
      },
    );
  requireCapability(deployCmd, "app:deploy");

  const redeployCmd = g
    .command("redeploy <group> <service>")
    .description("redeploy one compose service of the group")
    .option(
      "--force-recreate",
      "recreate the service's containers even when the image and configuration did not change",
    )
    .action(async (ref: string, service: string, opts: { forceRecreate?: boolean }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const group = await resolveGroup(ctx.client.get.bind(ctx.client), tid, ref);
      const apps = await ctx.client.get<{ items: MemberApp[] }>(
        `/tenants/${tid}/applications/?limit=200`,
      );
      const member = memberForService(apps.items ?? [], group.id, service);
      if (!member) {
        const services = (apps.items ?? [])
          .filter((a) => a.group_id === group.id)
          .map((a) => a.build?.compose_service)
          .filter((s): s is string => typeof s === "string" && s.length > 0);
        const e = new Error(
          `service '${service}' not found in group '${group.slug}'` +
            (services.length > 0 ? `. available: ${services.join(", ")}` : ""),
        ) as Error & { exitCode: number };
        e.exitCode = 5;
        throw e;
      }
      const result = await ctx.client.post<Record<string, unknown>>(
        `/tenants/${tid}/application-groups/${group.id}/services/${member.id}/redeploy`,
        opts.forceRecreate ? { force_recreate: true } : undefined,
      );
      printObject(result, fmt);
    });
  requireCapability(redeployCmd, "app:deploy");

  const runCmd = g
    .command("run <group> <service>")
    .description("run a one-shot task member (compose run --rm) with the stack's env")
    .option("--wait", "poll until the run finishes and print its outcome")
    .option("--wait-timeout <seconds>", "give up waiting after this long (default 600)", "600")
    .action(async (ref: string, service: string, opts: { wait?: boolean; waitTimeout: string }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const group = await resolveGroup(ctx.client.get.bind(ctx.client), tid, ref);
      const apps = await ctx.client.get<{ items: MemberApp[] }>(
        `/tenants/${tid}/applications/?limit=200`,
      );
      const member = memberForService(apps.items ?? [], group.id, service);
      if (!member) {
        const e = new Error(`service '${service}' not found in group '${group.slug}'`) as Error & {
          exitCode: number;
        };
        e.exitCode = 5;
        throw e;
      }
      const run = await ctx.client.post<GroupTaskRunRead>(
        `/tenants/${tid}/application-groups/${group.id}/services/${member.id}/run`,
      );
      if (!opts.wait) {
        printObject(run, fmt);
        if (fmt === "text") {
          console.log(`run started; watch it with: reoclo groups task-runs ${group.slug}`);
        }
        return;
      }

      const timeoutMs = Number(opts.waitTimeout) * 1000;
      const startedAt = Date.now();
      const base = `/tenants/${tid}/application-groups/${group.id}/task-runs`;
      for (;;) {
        if (Date.now() - startedAt > timeoutMs) {
          const e = new Error(
            `timed out after ${opts.waitTimeout}s waiting for task run ${run.id}`,
          ) as Error & { exitCode: number };
          e.exitCode = 12;
          throw e;
        }
        await new Promise((r) => setTimeout(r, 3000));
        const res = await ctx.client.get<PaginatedGroupTaskRuns>(
          `${base}?application_id=${member.id}&limit=5`,
        );
        const current = (res.items ?? []).find((r) => r.id === run.id);
        if (!current || !TERMINAL_TASK_RUN_STATUSES.has(current.status)) continue;
        if (fmt === "text") {
          console.log(`task ${service}: ${current.status} (exit ${current.exit_code ?? "?"})`);
          for (const line of current.log_tail ?? []) console.log(line);
        } else {
          printObject(current, fmt);
        }
        if (current.status !== "succeeded") {
          const e = new Error(
            current.error_message ?? `task run finished ${current.status}`,
          ) as Error & { exitCode: number };
          e.exitCode = 1;
          throw e;
        }
        return;
      }
    });
  requireCapability(runCmd, "app:deploy");

  g.command("task-runs <group>")
    .description("list one-shot task runs (newest first)")
    .option("--limit <n>", "max rows (default 20)", "20")
    .action(async (ref: string, opts: { limit: string }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const group = await resolveGroup(ctx.client.get.bind(ctx.client), tid, ref);
      const limit = parseLimit(opts.limit, 100);
      const res = await ctx.client.get<PaginatedGroupTaskRuns>(
        `/tenants/${tid}/application-groups/${group.id}/task-runs?limit=${limit}`,
      );
      printList(
        (res.items ?? []).map(taskRunSummary),
        [
          { key: "id", label: "ID" },
          { key: "service", label: "SERVICE" },
          { key: "status", label: "STATUS" },
          { key: "exit", label: "EXIT" },
          { key: "started", label: "STARTED" },
          { key: "duration", label: "DURATION" },
          { key: "error", label: "ERROR" },
        ],
        fmt,
      );
    });
}
