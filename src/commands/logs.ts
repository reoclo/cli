// src/commands/logs.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveServer } from "../client/resolve";
import { requireCapability, withCompletion } from "../client/command-meta";
import { globalOutput, printList, printObject, resolveFormat } from "../ui/output";
import { parseTimeSpec } from "../util/time";

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

  const tailCmd = withCompletion(g.command("tail"), {
    flags: {
      "--server": "servers",
      "--source": { enum: ["container", "system", "docker_daemon", "runner", "kernel", "auth"] },
    },
  });
  requireCapability(tailCmd, "container:logs:tail");
  tailCmd
    .description("fetch (or follow) logs from a server source via the runner")
    .requiredOption("--server <idOrName>", "server id or name")
    .requiredOption(
      "--source <type>",
      "source type: container|system|docker_daemon|runner|kernel|auth",
    )
    .requiredOption("--name <name>", "source name (container name or systemd unit)")
    .option("-f, --follow", "stream new log lines (polling every 2s)")
    .option("--since <duration>", "duration like 1h, 30m (passed to runner)", "5m")
    .option("--tail <N>", "initial lines to fetch", "100")
    .option("--search <pattern>", "regex to filter messages")
    .action(
      async (opts: {
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
      },
    );

  const HARD_LIMIT = 1000;
  const SERVER_MAX_PAGE = 500;

  interface SearchLogEntry {
    ts: string;
    level: string;
    server_id?: string;
    server_name?: string;
    source_type?: string;
    source_name?: string;
    message: string;
  }
  interface SearchLogResponse {
    items: SearchLogEntry[];
    total: number;
    page: number;
    page_size: number;
  }

  withCompletion(
    g
      .command("search [query]")
      .description("search Reoclo logs across servers and sources")
      .option("--server <slug-or-id>", "filter by server")
      .option("--source-type <type>", "container|system|docker_daemon|runner|kernel|auth")
      .option("--source-name <name>", "filter by source name (container name or systemd unit)")
      .option("--stream <s>", "stdout|stderr|journal")
      .option("--level <level>", "debug|info|warn|error|fatal")
      .option("--from <spec>", "earliest time (e.g. 24h, 7d, ISO 8601)")
      .option("--to <spec>", "latest time")
      .option("--limit <n>", "max rows (default 100, cap 1000)", "100")
      .action(
        async (
          query: string | undefined,
          opts: {
            server?: string;
            sourceType?: string;
            sourceName?: string;
            stream?: string;
            level?: string;
            from?: string;
            to?: string;
            limit: string;
          },
        ) => {
          const fmt = resolveFormat(globalOutput(program));
          const ctx = await bootstrap();
          const tid = requireTenantId(ctx);

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

          let serverId: string | undefined;
          if (opts.server) serverId = await resolveServer(ctx.client, tid, opts.server);

          const fromDate = opts.from ? parseTimeSpec(opts.from).toISOString() : undefined;
          const toDate = opts.to ? parseTimeSpec(opts.to).toISOString() : undefined;

          const items: SearchLogEntry[] = [];
          let page = 1;
          while (items.length < limit) {
            const q = new URLSearchParams({
              page: String(page),
              page_size: String(pageSize),
            });
            if (query) q.set("search", query);
            if (serverId) q.set("server_id", serverId);
            if (opts.sourceType) q.set("source_type", opts.sourceType);
            if (opts.sourceName) q.set("source_name", opts.sourceName);
            if (opts.stream) q.set("stream", opts.stream);
            if (opts.level) q.set("level", opts.level);
            if (fromDate) q.set("from_date", fromDate);
            if (toDate) q.set("to_date", toDate);
            const res = await ctx.client.get<SearchLogResponse>(
              `/tenants/${tid}/logs?${q.toString()}`,
            );
            for (const row of res.items) {
              if (items.length >= limit) break;
              items.push(row);
            }
            if (res.items.length < pageSize) break;
            page += 1;
          }

          if (fmt === "json" || fmt === "yaml") {
            for (const item of items) {
              printObject(item as unknown as Record<string, unknown>, fmt);
            }
            return;
          }
          const rows = items.map((r) => ({
            time: r.ts.replace("T", " ").replace("Z", ""),
            level: r.level,
            server: r.server_name ?? r.server_id ?? "",
            source: `${r.source_type ?? ""}:${r.source_name ?? ""}`,
            message: r.message,
          }));
          printList(
            rows as unknown as Array<Record<string, unknown>>,
            [
              { key: "time", label: "TIME" },
              { key: "level", label: "LEVEL" },
              { key: "server", label: "SERVER" },
              { key: "source", label: "SOURCE" },
              { key: "message", label: "MESSAGE" },
            ],
            fmt,
          );
        },
      ),
    {
      flags: {
        "--server": "servers",
        "--source-type": { enum: ["container", "system", "docker_daemon", "runner", "kernel", "auth"] },
        "--stream": { enum: ["stdout", "stderr", "journal"] },
        "--level": { enum: ["debug", "info", "warn", "error", "fatal"] },
      },
    },
  );
}
