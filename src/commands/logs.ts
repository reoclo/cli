// src/commands/logs.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveServer } from "../client/resolve";
import { requireCapability, withCompletion } from "../client/command-meta";
import { globalOutput, printList, printObject, resolveFormat } from "../ui/output";
import { parseTimeSpec } from "../util/time";
import {
  LOG_LEVELS,
  LogLevelSchema,
  SOURCE_TYPES,
  SourceTypeSchema,
  STREAMS,
  StreamSchema,
} from "../client/enums";
import { parseLimit } from "../util/parse-limit";

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
      "--source": { enum: [...SOURCE_TYPES] },
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
        const source = SourceTypeSchema.parse(opts.source);
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const sid = await resolveServer(ctx.client, tid, opts.server);

        const baseQs = (sinceParam: string, tailParam: string): string => {
          const params = new URLSearchParams({
            server_id: sid,
            source_type: source,
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

          const limit = parseLimit(opts.limit, HARD_LIMIT);
          const pageSize = Math.min(limit, SERVER_MAX_PAGE);

          const level = opts.level !== undefined ? LogLevelSchema.parse(opts.level) : undefined;
          const sourceType = opts.sourceType !== undefined ? SourceTypeSchema.parse(opts.sourceType) : undefined;
          const stream = opts.stream !== undefined ? StreamSchema.parse(opts.stream) : undefined;

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
            if (sourceType) q.set("source_type", sourceType);
            if (opts.sourceName) q.set("source_name", opts.sourceName);
            if (stream) q.set("stream", stream);
            if (level) q.set("level", level);
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
        "--source-type": { enum: [...SOURCE_TYPES] },
        "--stream": { enum: [...STREAMS] },
        "--level": { enum: [...LOG_LEVELS] },
      },
    },
  );

  withCompletion(
    g
      .command("system <server>")
      .description("fetch systemd journal logs from a server")
      .option("--unit <unit>", "systemd unit (default: kernel)", "kernel")
      .option("--tail <n>", "lines to fetch (default 200)", "200")
      .option("--since <spec>", "earliest time (e.g. 1h, 24h, ISO)")
      .option("--search <pattern>", "regex to filter messages")
      .option("--level <level>", "filter by level")
      .action(
        async (
          server: string,
          opts: { unit: string; tail: string; since?: string; search?: string; level?: string },
        ) => {
          const ctx = await bootstrap();
          const tid = requireTenantId(ctx);
          const sid = await resolveServer(ctx.client, tid, server);

          const level = opts.level !== undefined ? LogLevelSchema.parse(opts.level) : undefined;

          const q = new URLSearchParams({
            server_id: sid,
            source_type: "system",
            source_name: opts.unit,
            tail: opts.tail,
          });
          if (opts.since) q.set("since", parseTimeSpec(opts.since).toISOString());
          if (opts.search) q.set("search", opts.search);
          if (level) q.set("level", level);

          const res = await ctx.client.get<LiveLogResponse>(
            `/tenants/${tid}/logs/live?${q.toString()}`,
          );
          const fmt = resolveFormat(globalOutput(program));
          if (fmt === "json" || fmt === "yaml") {
            printObject(res as unknown as Record<string, unknown>, fmt);
            return;
          }
          for (const e of res.entries) {
            process.stdout.write(`${e.ts} [${e.level}] ${e.message}\n`);
          }
        },
      ),
    { args: [{ slot: 0, resource: "servers" }] },
  );

  g.command("stats")
    .description("show tenant-wide log counts by level and source")
    .option("--from <spec>", "earliest time")
    .option("--to <spec>", "latest time")
    .action(async (opts: { from?: string; to?: string }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);

      const q = new URLSearchParams();
      if (opts.from) q.set("since", parseTimeSpec(opts.from).toISOString());
      if (opts.to) q.set("until", parseTimeSpec(opts.to).toISOString());
      const qs = q.toString();
      interface LogStats {
        by_level: Record<string, number>;
        by_source_type: Record<string, number>;
        total: number;
        error_count: number;
        warn_count: number;
      }
      const r = await ctx.client.get<LogStats>(
        `/tenants/${tid}/logs/stats${qs ? `?${qs}` : ""}`,
      );

      if (fmt === "json" || fmt === "yaml") {
        printObject(r as unknown as Record<string, unknown>, fmt);
        return;
      }

      // The endpoint can return null for the maps when no logs match; treat
      // those as empty objects so Object.entries / printList don't crash.
      const byLevel = r.by_level ?? {};
      const bySource = r.by_source_type ?? {};
      const total = r.total ?? 0;
      const errors = r.error_count ?? 0;
      const warns = r.warn_count ?? 0;
      process.stdout.write("By level\n");
      const levelRows = Object.entries(byLevel).map(([level, count]) => ({ level, count }));
      printList(
        levelRows as unknown as Array<Record<string, unknown>>,
        [
          { key: "level", label: "LEVEL" },
          { key: "count", label: "COUNT" },
        ],
        "text",
      );
      process.stdout.write("\nBy source type\n");
      const sourceRows = Object.entries(bySource).map(([source, count]) => ({ source, count }));
      printList(
        sourceRows as unknown as Array<Record<string, unknown>>,
        [
          { key: "source", label: "SOURCE" },
          { key: "count", label: "COUNT" },
        ],
        "text",
      );
      const rate = total > 0 ? ((errors / total) * 100).toFixed(2) : "0.00";
      process.stdout.write(`\nTotal: ${total}  errors: ${errors} (${rate}%)  warnings: ${warns}\n`);
    });

  g.command("usage")
    .description("show tenant-wide log storage and retention")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const r = await ctx.client.get<Record<string, unknown>>(`/tenants/${tid}/logs/usage`);
      printObject(r, fmt);
    });

  withCompletion(
    g
      .command("sources <server>")
      .description("list log sources (containers + systemd units) on a server")
      .action(async (server: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const sid = await resolveServer(ctx.client, tid, server);

        interface LogSources {
          containers: Array<{ name: string; image: string; status: string }>;
          journal_units: Array<{ unit: string; description: string }>;
        }
        const res = await ctx.client.get<LogSources>(
          `/tenants/${tid}/logs/sources?server_id=${sid}`,
        );

        if (fmt === "json" || fmt === "yaml") {
          printObject(res as unknown as Record<string, unknown>, fmt);
          return;
        }

        // Server can return null for either array when the runner snapshot
        // is unavailable; treat as empty so printList doesn't crash.
        const containers = res.containers ?? [];
        const journalUnits = res.journal_units ?? [];
        process.stdout.write("Containers\n");
        printList(
          containers as unknown as Array<Record<string, unknown>>,
          [
            { key: "name", label: "NAME" },
            { key: "image", label: "IMAGE" },
            { key: "status", label: "STATUS" },
          ],
          "text",
        );
        process.stdout.write("\nJournal units\n");
        printList(
          journalUnits as unknown as Array<Record<string, unknown>>,
          [
            { key: "unit", label: "UNIT" },
            { key: "description", label: "DESCRIPTION" },
          ],
          "text",
        );
      }),
    { args: [{ slot: 0, resource: "servers" }] },
  );
}
