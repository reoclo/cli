// src/commands/logs.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveServer } from "../client/resolve";

interface LiveLogEntry {
  ts: string;
  level: string;
  message: string;
  server_id?: string;
  server_name?: string;
  source_name?: string;
  [k: string]: unknown;
}

interface LiveLogResponse {
  server_id: string;
  server_name: string;
  source_type: string;
  source_name: string;
  entries: LiveLogEntry[];
  fetched_at: string;
}

export function registerLogs(program: Command): void {
  const g = program.command("logs").description("logs");

  g.command("tail")
    .description("fetch (or follow) logs from a server source via the runner")
    .requiredOption("--server <idOrName>", "server id or name")
    .requiredOption("--source <type>", "source type: container|system|docker_daemon|runner|kernel|auth")
    .requiredOption("--name <name>", "source name (container name or systemd unit)")
    .option("-f, --follow", "stream new log lines (polling every 2s)")
    .option("--since <duration>", "duration like 1h, 30m (passed to runner)", "5m")
    .option("--tail <N>", "initial lines to fetch", "100")
    .option("--search <pattern>", "regex to filter messages")
    .action(async (opts: {
      server: string;
      source: string;
      name: string;
      follow?: boolean;
      since: string;
      tail: string;
      search?: string;
    }) => {
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const sid = await resolveServer(ctx.client, tid, opts.server);

      const baseQs = (sinceParam: string, tailParam: string): string => {
        const params = new URLSearchParams({
          server_id: sid,
          source_type: opts.source,
          source_name: opts.name,
          since: sinceParam,
          tail: tailParam,
        });
        if (opts.search) params.set("search", opts.search);
        return params.toString();
      };

      const printEntries = (entries: LiveLogEntry[]): void => {
        for (const e of entries) {
          process.stdout.write(`${e.ts} [${e.level}] ${e.message}\n`);
        }
      };

      // Initial fetch
      const initial = await ctx.client.get<LiveLogResponse>(
        `/tenants/${tid}/logs/live?${baseQs(opts.since, opts.tail)}`,
      );
      printEntries(initial.entries);

      if (!opts.follow) return;

      // Follow: poll every 2s. Use the most recent ts seen as the new `since`.
      let lastTs = initial.entries.at(-1)?.ts ?? new Date().toISOString();
      // Catch SIGINT to exit cleanly.
      let stopped = false;
      process.once("SIGINT", () => {
        stopped = true;
      });

      while (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (stopped) break;

        // Use a slightly earlier timestamp to avoid missing edge logs;
        // dedupe by tracking the last printed ts.
        const res = await ctx.client.get<LiveLogResponse>(
          `/tenants/${tid}/logs/live?${baseQs(lastTs, "200")}`,
        );

        // Skip entries we already printed (entries with ts <= lastTs)
        const fresh = res.entries.filter((e) => e.ts > lastTs);
        if (fresh.length > 0) {
          printEntries(fresh);
          lastTs = fresh.at(-1)!.ts;
        }
      }
    });
}
