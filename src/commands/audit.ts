// src/commands/audit.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { globalOutput, printList, resolveFormat } from "../ui/output";
import { parseTimeSpec } from "../util/time";

interface AuditLog {
  id: string;
  actor_id: string;
  actor_email?: string;
  action: string;
  resource_type: string;
  resource_id?: string | null;
  resource_name?: string | null;
  created_at: string;
}

interface AuditListResponse {
  items: AuditLog[];
  total: number;
  page: number;
  page_size: number;
}

interface UserList {
  items: Array<{ id: string; email: string }>;
}

const HARD_LIMIT = 1000;
const SERVER_MAX_PAGE = 200;

export function registerAudit(program: Command): void {
  const g = program.command("audit").description("inspect tenant audit logs");

  g.command("ls")
    .description("list audit log entries")
    .option("--actor <id-or-email>", "actor id or email")
    .option("--action <verb>", "audit action verb")
    .option("--resource-type <type>", "resource type (application, server, …)")
    .option("--resource-id <id>", "resource id")
    .option("--from <spec>", "earliest time (e.g. 24h, 7d, 2026-05-15, ISO)")
    .option("--to <spec>", "latest time (e.g. 1h, 2026-05-19, ISO)")
    .option("--limit <n>", "max rows (default 50, cap 1000)", "50")
    .action(
      async (opts: {
        actor?: string;
        action?: string;
        resourceType?: string;
        resourceId?: string;
        from?: string;
        to?: string;
        limit: string;
      }) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);

        // Resolve --actor email → id if it looks like an email.
        let actorId: string | undefined;
        if (opts.actor) {
          if (opts.actor.includes("@")) {
            const u = await ctx.client.get<UserList>(
              `/tenants/${tid}/users?search=${encodeURIComponent(opts.actor)}`,
            );
            actorId = u.items[0]?.id ?? opts.actor; // fall through to literal
          } else {
            actorId = opts.actor;
          }
        }

        const fromDate = opts.from ? parseTimeSpec(opts.from).toISOString() : undefined;
        const toDate = opts.to ? parseTimeSpec(opts.to).toISOString() : undefined;

        const parsed = Number(opts.limit);
        if (!Number.isFinite(parsed) || parsed < 1) {
          const e = new Error(
            `invalid --limit: '${opts.limit}' (expected positive integer)`,
          ) as Error & { exitCode: number };
          e.exitCode = 2;
          throw e;
        }
        const limit = Math.min(parsed, HARD_LIMIT);
        const pageSize = Math.min(limit, SERVER_MAX_PAGE);

        const items: AuditLog[] = [];
        let page = 1;
        while (items.length < limit) {
          const q = new URLSearchParams({
            page: String(page),
            page_size: String(pageSize),
          });
          if (actorId) q.set("actor_id", actorId);
          if (opts.action) q.set("action", opts.action);
          if (opts.resourceType) q.set("resource_type", opts.resourceType);
          if (opts.resourceId) q.set("resource_id", opts.resourceId);
          if (fromDate) q.set("from_date", fromDate);
          if (toDate) q.set("to_date", toDate);
          const res = await ctx.client.get<AuditListResponse>(
            `/tenants/${tid}/audit-logs?${q.toString()}`,
          );
          for (const row of res.items) {
            if (items.length >= limit) break;
            items.push(row);
          }
          if (res.items.length < pageSize) break;
          page += 1;
        }

        const rows = items.map((r) => ({
          time: r.created_at.replace("T", " ").replace("Z", ""),
          actor: r.actor_email ?? r.actor_id.slice(0, 8),
          action: r.action,
          resource: `${r.resource_type}:${r.resource_name ?? r.resource_id ?? ""}`,
        }));
        printList(
          rows as unknown as Array<Record<string, unknown>>,
          [
            { key: "time", label: "TIME" },
            { key: "actor", label: "ACTOR" },
            { key: "action", label: "ACTION" },
            { key: "resource", label: "RESOURCE" },
          ],
          fmt,
        );
      },
    );
}
