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

/** Write an advisory line to stderr (kept off stdout so piped JSON stays clean). */
function notice(msg: string): void {
  process.stderr.write(`note: ${msg}\n`);
}

/**
 * Printed when a centralized-log query returns zero rows. Reoclo only has logs
 * to search once ingestion is active for the tenant; until then these queries
 * are legitimately empty — not a malformed query — so say so explicitly and
 * point at the live container-log fallback instead of leaving the user guessing.
 */
export function noLogsNotice(serverId?: string): void {
  const scope = serverId ? "this server" : "this tenant";
  notice(
    `no ingested logs matched for ${scope}. ` +
      "If log ingestion isn't active yet this stays empty regardless of the query — " +
      "use 'reoclo containers logs <server> <name>' or 'reoclo logs tail' for live container logs.",
  );
}

/**
 * True when a `logs usage` payload reports no ingested data — used to flag that
 * centralized ingestion looks inactive even though a retention window is set.
 */
export function ingestionLooksInactive(usage: Record<string, unknown>): boolean {
  const streams = Number(usage["total_streams"] ?? 0);
  const bytes = Number(usage["total_bytes"] ?? 0);
  return (!Number.isFinite(streams) || streams === 0) && (!Number.isFinite(bytes) || bytes === 0);
}

interface ServerLogStat {
  server_id: string;
  server_name: string;
  bytes: number;
  streams: number;
}

/** Shape returned by `GET /tenants/{id}/logs/stats`. */
interface LogStatsPayload {
  total_bytes: number;
  total_entries: number;
  total_streams: number;
  retention_days: number;
  breakdown_by_server: ServerLogStat[];
}

/**
 * Build the rendered per-server rows + summary line for `logs stats`, or null
 * when the tenant has no ingested logs. Pure so it can be unit-tested without a
 * client. The endpoint reports per-server *streams* (not bytes), so the
 * breakdown table omits the always-zero per-server byte count; total bytes live
 * in the summary.
 */
export function formatLogStats(
  r: Partial<LogStatsPayload> & Record<string, unknown>,
): { rows: Array<{ server: string; streams: number }>; summary: string } | null {
  if (ingestionLooksInactive(r)) return null;
  const rows = (r.breakdown_by_server ?? []).map((s) => ({
    server: s.server_name,
    streams: s.streams,
  }));
  const summary =
    `Total: ${r.total_entries ?? 0} entries  ${r.total_streams ?? 0} streams  ` +
    `${r.total_bytes ?? 0} bytes  (retention ${r.retention_days ?? 0}d)`;
  return { rows, summary };
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
      .option("--from <spec>", "earliest time (for example 24h, 7d, ISO 8601)")
      .option("--to <spec>", "latest time")
      .option("--limit <n>", "max rows (default 100, cap 1000)", "100")
      .option("--count", "print only the total match count (triage mode)")
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
            count?: boolean;
          },
        ) => {
          const fmt = resolveFormat(globalOutput(program));
          const ctx = await bootstrap();
          const tid = requireTenantId(ctx);

          const limit = parseLimit(opts.limit, HARD_LIMIT);
          const pageSize = Math.min(limit, SERVER_MAX_PAGE);

          const level = opts.level !== undefined ? LogLevelSchema.parse(opts.level) : undefined;
          const sourceType =
            opts.sourceType !== undefined ? SourceTypeSchema.parse(opts.sourceType) : undefined;
          const stream = opts.stream !== undefined ? StreamSchema.parse(opts.stream) : undefined;

          let serverId: string | undefined;
          if (opts.server) serverId = await resolveServer(ctx.client, tid, opts.server);

          const fromDate = opts.from ? parseTimeSpec(opts.from).toISOString() : undefined;
          const toDate = opts.to ? parseTimeSpec(opts.to).toISOString() : undefined;

          const mkQuery = (page: number, size: number): URLSearchParams => {
            const q = new URLSearchParams({ page: String(page), page_size: String(size) });
            if (query) q.set("search", query);
            if (serverId) q.set("server_id", serverId);
            if (sourceType) q.set("source_type", sourceType);
            if (opts.sourceName) q.set("source_name", opts.sourceName);
            if (stream) q.set("stream", stream);
            if (level) q.set("level", level);
            if (fromDate) q.set("from_date", fromDate);
            if (toDate) q.set("to_date", toDate);
            return q;
          };

          // --count: ask for a single row only and report the server-side total.
          if (opts.count) {
            const res = await ctx.client.get<SearchLogResponse>(
              `/tenants/${tid}/logs?${mkQuery(1, 1).toString()}`,
            );
            if (fmt === "json" || fmt === "yaml") {
              printObject({ total: res.total ?? 0 }, fmt);
            } else {
              process.stdout.write(`${res.total ?? 0}\n`);
            }
            return;
          }

          const items: SearchLogEntry[] = [];
          let page = 1;
          while (items.length < limit) {
            const res = await ctx.client.get<SearchLogResponse>(
              `/tenants/${tid}/logs?${mkQuery(page, pageSize).toString()}`,
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
          if (items.length === 0) {
            noLogsNotice(serverId);
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
      .option("--since <spec>", "earliest time (for example 1h, 24h, ISO)")
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
    .description("show tenant-wide log storage totals and per-server breakdown")
    .option("--from <spec>", "earliest time")
    .option("--to <spec>", "latest time")
    .action(async (opts: { from?: string; to?: string }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);

      const q = new URLSearchParams();
      if (opts.from) q.set("from_date", parseTimeSpec(opts.from).toISOString());
      if (opts.to) q.set("to_date", parseTimeSpec(opts.to).toISOString());
      const qs = q.toString();
      const r = await ctx.client.get<LogStatsPayload>(
        `/tenants/${tid}/logs/stats${qs ? `?${qs}` : ""}`,
      );

      if (fmt === "json" || fmt === "yaml") {
        printObject(r as unknown as Record<string, unknown>, fmt);
        return;
      }

      const formatted = formatLogStats(r as unknown as Record<string, unknown>);
      if (!formatted) {
        noLogsNotice();
        return;
      }
      if (formatted.rows.length > 0) {
        process.stdout.write("By server\n");
        printList(
          formatted.rows as unknown as Array<Record<string, unknown>>,
          [
            { key: "server", label: "SERVER" },
            { key: "streams", label: "STREAMS" },
          ],
          "text",
        );
        process.stdout.write("\n");
      }
      process.stdout.write(`${formatted.summary}\n`);
    });

  g.command("usage")
    .description("show tenant-wide log storage and retention")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const r = await ctx.client.get<Record<string, unknown>>(`/tenants/${tid}/logs/usage`);
      printObject(r, fmt);
      if (fmt === "text" && ingestionLooksInactive(r)) {
        notice(
          "log ingestion is not active for this tenant (0 streams / 0 bytes) — " +
            "the retention window applies only once streams start arriving. " +
            "Until then, use 'reoclo containers logs' / 'reoclo logs tail' for live container logs.",
        );
      }
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
        if (containers.length === 0 && journalUnits.length === 0) {
          notice(
            "no log sources reported for this server. The runner snapshot may be stale or " +
              "unavailable — try 'reoclo containers refresh', then " +
              "'reoclo containers ls --server <server>' for the live container list.",
          );
          return;
        }
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
