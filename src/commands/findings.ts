// src/commands/findings.ts
//
// Log watcher findings (REO-610): what the watcher agent surfaced from an
// organization's logs. They are not alerts or incidents, so `alerts list` and
// `incidents ls` never show them; this is the CLI's way in.
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { requireCapability, withCompletion } from "../client/command-meta";
import { ApiError, NotFoundError } from "../client/errors";
import type { HttpClient } from "../client/http";
import { resolveApp, resolveServer } from "../client/resolve";
import { globalOutput, printList, printMutation, printObject, resolveFormat } from "../ui/output";

// Mirror the API's FindingStatus / FindingSeverity / FindingCategory enums.
const FINDING_STATUSES = ["open", "acknowledged", "resolved", "muted"];
const FINDING_SEVERITIES = ["info", "low", "medium", "high", "critical"];
const FINDING_CATEGORIES = ["code", "infra", "ops"];
const PAGE_SIZE_MAX = 200;

interface FindingEvidence {
  ts: string;
  level: string;
  source_name: string;
  message: string;
}

interface Finding {
  id: string;
  status: string;
  severity: string;
  category: string;
  title: string;
  summary: string;
  occurrences: number;
  last_seen_at: string;
  server_name: string | null;
  source_name: string | null;
  evidence: FindingEvidence[];
}

interface FindingPage {
  items: Finding[];
  page: number;
  page_size: number;
  total: number;
}

/** The finding routes answer 404 when the log watcher is off for the organization. */
async function withWatcherHint<T>(call: () => Promise<T>, what: string): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      const notFound = new NotFoundError(
        `${what} not found, or the log watcher is not enabled for this organization`,
        e.path,
      );
      notFound.hint = "Findings come from the log watcher; enable it in the organization settings.";
      throw notFound;
    }
    throw e;
  }
}

/** One line pointing at `findings list`, or null when nothing is open or the caller cannot see findings. */
export async function openFindingsNote(
  client: HttpClient,
  tenantId: string,
): Promise<string | null> {
  try {
    const page = await client.get<FindingPage>(
      `/tenants/${tenantId}/log-watcher/findings?status=open&page_size=1`,
    );
    if (page.total === 0) return null;
    const noun = page.total === 1 ? "finding" : "findings";
    return `${page.total} open log watcher ${noun}: run 'reoclo findings list'`;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return null;
    throw e;
  }
}

export function registerFindings(program: Command): void {
  const g = program.command("findings").description("log watcher findings");

  const listCmd = g
    .command("list")
    .alias("ls")
    .description("list log watcher findings (open ones by default)")
    .option(
      "--state <state>",
      "open (default), acknowledged, resolved, muted, or all",
      "open",
    )
    .option("--status <state>", "same as --state")
    .option("--severity <severity>", "filter by severity (info|low|medium|high|critical)")
    .option("--category <category>", "filter by category (code|infra|ops)")
    .option("--app <app>", "filter to one application (slug, name or id)")
    .option("--server <server>", "filter to one server (slug, name or id)")
    .option("--limit <n>", `most findings to list (default 50, max ${PAGE_SIZE_MAX})`)
    .action(
      async (opts: {
        state: string;
        status?: string;
        severity?: string;
        category?: string;
        app?: string;
        server?: string;
        limit?: string;
      }) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const params = new URLSearchParams();
        const state = opts.status ?? opts.state;
        if (state !== "all") params.set("status", state);
        if (opts.severity) params.set("severity", opts.severity);
        if (opts.category) params.set("category", opts.category);
        if (opts.app) params.set("application_id", await resolveApp(ctx.client, tid, opts.app));
        if (opts.server) {
          params.set("server_id", await resolveServer(ctx.client, tid, opts.server));
        }
        if (opts.limit !== undefined) {
          const limit = Number(opts.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_SIZE_MAX) {
            const e = new Error(
              `invalid --limit '${opts.limit}' (expected 1-${PAGE_SIZE_MAX})`,
            ) as Error & { exitCode: number };
            e.exitCode = 4;
            throw e;
          }
          params.set("page_size", String(limit));
        }
        const qs = params.toString() ? `?${params.toString()}` : "";
        const page = await withWatcherHint(
          () => ctx.client.get<FindingPage>(`/tenants/${tid}/log-watcher/findings${qs}`),
          "findings",
        );
        printList(
          page.items as unknown as Array<Record<string, unknown>>,
          [
            { key: "id", label: "ID" },
            { key: "severity", label: "SEVERITY" },
            { key: "status", label: "STATUS" },
            { key: "category", label: "CATEGORY" },
            { key: "server_name", label: "SERVER" },
            { key: "source_name", label: "SOURCE" },
            { key: "occurrences", label: "SEEN" },
            { key: "last_seen_at", label: "LAST SEEN" },
            { key: "title", label: "TITLE" },
          ],
          fmt,
        );
        if (fmt === "text" && page.total > page.items.length) {
          process.stderr.write(
            `showing ${page.items.length} of ${page.total} findings; narrow with --severity, --app or --server, or raise --limit\n`,
          );
        }
      },
    );
  requireCapability(listCmd, "watch:findings:read");
  withCompletion(listCmd, {
    flags: {
      "--state": { enum: [...FINDING_STATUSES, "all"] },
      "--status": { enum: [...FINDING_STATUSES, "all"] },
      "--severity": { enum: FINDING_SEVERITIES },
      "--category": { enum: FINDING_CATEGORIES },
      "--app": "apps",
      "--server": "servers",
    },
  });

  const getCmd = g
    .command("get <id>")
    .description("show one finding with its evidence")
    .action(async (id: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const finding = await withWatcherHint(
        () => ctx.client.get<Finding>(`/tenants/${tid}/log-watcher/findings/${id}`),
        `finding ${id}`,
      );
      if (fmt !== "text") {
        printObject(finding as unknown as Record<string, unknown>, fmt);
        return;
      }
      const { evidence, ...fields } = finding;
      printObject(fields, fmt);
      if (evidence.length > 0) {
        process.stdout.write("\nEVIDENCE\n");
        for (const line of evidence) {
          process.stdout.write(`${line.ts}  ${line.level}  ${line.source_name}  ${line.message}\n`);
        }
      }
    });
  requireCapability(getCmd, "watch:findings:read");

  for (const [name, status, past] of [
    ["ack", "acknowledged", "acknowledged"],
    ["resolve", "resolved", "resolved"],
  ] as const) {
    const cmd = g
      .command(`${name} <id>`)
      .description(`mark a finding ${past}`)
      .action(async (id: string) => {
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const result = await withWatcherHint(
          () =>
            ctx.client.patch<Record<string, unknown>>(
              `/tenants/${tid}/log-watcher/findings/${id}`,
              { status },
            ),
          `finding ${id}`,
        );
        printMutation(program, result, `✓ finding ${past}: ${id}`);
      });
    requireCapability(cmd, "watch:findings:write");
  }
}
