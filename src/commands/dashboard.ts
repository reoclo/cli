// src/commands/dashboard.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { globalOutput, printList, printObject, resolveFormat } from "../ui/output";

interface ActivityEntry {
  id: string;
  action: string;
  resource_type: string;
  resource_name?: string | null;
  actor_email?: string | null;
  created_at: string;
}

interface DailyDeployCount {
  date: string;
  total: number;
  succeeded: number;
  failed: number;
}

interface DashboardStats {
  server_count: number;
  server_healthy_count: number;
  application_count: number;
  application_running_count: number;
  domain_count: number;
  domain_healthy_count: number;
  open_incident_count: number;
  recent_activity: ActivityEntry[];
  deploy_history: DailyDeployCount[];
}

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

function sparkline(values: number[]): string {
  const max = Math.max(1, ...values);
  return values
    .map((v) => SPARK[Math.min(SPARK.length - 1, Math.floor((v / max) * SPARK.length))])
    .join("");
}

export function registerDashboard(program: Command): void {
  program
    .command("dashboard")
    .description("show organization summary (counts, recent activity, deploys)")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const stats = await ctx.client.get<DashboardStats>(`/tenants/${tid}/dashboard/stats`);

      if (fmt === "json" || fmt === "yaml") {
        printObject(stats as unknown as Record<string, unknown>, fmt);
        return;
      }

      process.stdout.write("Counts\n");
      process.stdout.write(`  servers       ${stats.server_healthy_count}/${stats.server_count}\n`);
      process.stdout.write(
        `  applications  ${stats.application_running_count}/${stats.application_count}\n`,
      );
      process.stdout.write(`  domains       ${stats.domain_healthy_count}/${stats.domain_count}\n`);
      process.stdout.write(`  incidents     ${stats.open_incident_count} open\n\n`);

      if (stats.recent_activity.length > 0) {
        process.stdout.write("Recent activity\n");
        const rows = stats.recent_activity.map((a) => ({
          time: a.created_at.replace("T", " ").replace("Z", ""),
          actor: a.actor_email ?? "",
          action: a.action,
          resource: `${a.resource_type}:${a.resource_name ?? ""}`,
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
        process.stdout.write("\n");
      }

      const last14 = stats.deploy_history.slice(-14);
      if (last14.length > 0) {
        const totals = last14.map((d) => d.total);
        const succeeded = last14.reduce((s, d) => s + d.succeeded, 0);
        const failed = last14.reduce((s, d) => s + d.failed, 0);
        process.stdout.write(`Deploys (${last14.length}d) ${sparkline(totals)}\n`);
        process.stdout.write(`  succeeded: ${succeeded}  failed: ${failed}\n`);
      }
    });
}
