// src/commands/schedule.ts
//
// `reoclo schedule` — manage scheduled operations (cron/once deploys,
// restarts, commands, reboots) and inspect their run history.
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { withCompletion } from "../client/command-meta";
import { cacheList } from "../completion/populate";
import { globalOutput, printList, printObject, resolveFormat } from "../ui/output";

const OP_TYPES = ["DEPLOY", "COMMAND", "RESTART", "REBOOT"];
const SCHEDULE_KINDS = ["CRON", "ONCE"];
const CONCURRENCY = ["SKIP", "QUEUE", "REPLACE"];
const OP_STATUSES = ["ACTIVE", "PAUSED", "DELETED"];
const RUN_STATUSES = [
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
  "CANCELLED",
  "TIMED_OUT",
];

interface ScheduledOp {
  id: string;
  name: string;
  operation_type: string;
  status: string;
  schedule_kind: string;
  cron_expression: string | null;
  state?: { next_run_at?: string | null; last_run_status?: string | null };
}

interface ScheduledRun {
  id: string;
  status: string;
  scheduled_for: string;
  started_at: string | null;
  duration_seconds: number | null;
  attempt: number;
  output?: string | null;
}

/** Accumulate a repeatable `--param key=value` flag into a dict. */
function collectParam(value: string, prev: Record<string, string>): Record<string, string> {
  const eq = value.indexOf("=");
  if (eq <= 0) {
    throw new Error(`invalid --param '${value}' (expected key=value)`);
  }
  return { ...prev, [value.slice(0, eq)]: value.slice(eq + 1) };
}

export function registerSchedule(program: Command): void {
  const g = program.command("schedule").description("manage scheduled operations");

  withCompletion(
    g
      .command("ls")
      .description("list scheduled operations")
      .option("--status <status>", "filter by status")
      .option("--type <type>", "filter by operation type")
      .action(async (opts: { status?: string; type?: string }) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const params = new URLSearchParams();
        if (opts.status) params.set("status", opts.status);
        if (opts.type) params.set("operation_type", opts.type);
        const qs = params.toString();
        const list = await ctx.client.get<ScheduledOp[]>(
          `/tenants/${tid}/scheduled-operations${qs ? `?${qs}` : ""}`,
        );
        cacheList("schedule", list);
        const rows = list.map((o) => ({
          ...o,
          next_run: o.state?.next_run_at ?? "",
          last_run: o.state?.last_run_status ?? "",
        }));
        printList(
          rows as unknown as Array<Record<string, unknown>>,
          [
            { key: "id", label: "ID" },
            { key: "name", label: "NAME" },
            { key: "operation_type", label: "TYPE" },
            { key: "status", label: "STATUS" },
            { key: "schedule_kind", label: "SCHEDULE" },
            { key: "next_run", label: "NEXT RUN" },
            { key: "last_run", label: "LAST RUN" },
          ],
          fmt,
        );
      }),
    { flags: { "--status": { enum: OP_STATUSES }, "--type": { enum: OP_TYPES } } },
  );

  withCompletion(
    g
      .command("get <id>")
      .description("show one scheduled operation")
      .action(async (id: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const op = await ctx.client.get<Record<string, unknown>>(
          `/tenants/${tid}/scheduled-operations/${id}`,
        );
        printObject(op, fmt);
      }),
    { args: [{ slot: 0, resource: "schedule" }] },
  );

  withCompletion(
    g
      .command("create")
      .description("create a scheduled operation")
      .requiredOption("--name <name>", "operation name")
      .requiredOption("--type <type>", "DEPLOY|COMMAND|RESTART|REBOOT")
      .requiredOption("--schedule <kind>", "CRON|ONCE")
      .option("--description <text>", "description")
      .option("--cron <expr>", "cron expression (required for CRON)")
      .option("--timezone <tz>", "timezone (default UTC)")
      .option("--at <datetime>", "run time, RFC 3339 (required for ONCE)")
      .option("--server <id>", "target server id")
      .option("--app <id>", "target application id")
      .option("--command <cmd>", "command to run (for COMMAND ops)")
      .option("--param <kv>", "extra param key=value (repeatable)", collectParam, {})
      .option("--concurrency <policy>", "SKIP|QUEUE|REPLACE")
      .option("--max-retries <n>", "max retries (0-3)")
      .option("--retry-delay <seconds>", "retry delay seconds (30-600)")
      .option("--timeout <seconds>", "timeout seconds (30-3600)")
      .action(
        async (opts: {
          name: string;
          type: string;
          schedule: string;
          description?: string;
          cron?: string;
          timezone?: string;
          at?: string;
          server?: string;
          app?: string;
          command?: string;
          param: Record<string, string>;
          concurrency?: string;
          maxRetries?: string;
          retryDelay?: string;
          timeout?: string;
        }) => {
          const fmt = resolveFormat(globalOutput(program));
          const ctx = await bootstrap();
          const tid = requireTenantId(ctx);
          const body: Record<string, unknown> = {
            name: opts.name,
            operation_type: opts.type,
            schedule_kind: opts.schedule,
          };
          if (opts.description !== undefined) body.description = opts.description;
          if (opts.cron !== undefined) body.cron_expression = opts.cron;
          if (opts.timezone !== undefined) body.timezone = opts.timezone;
          if (opts.at !== undefined) body.scheduled_at = opts.at;
          if (opts.server !== undefined) body.server_id = opts.server;
          if (opts.app !== undefined) body.application_id = opts.app;
          const params: Record<string, unknown> = { ...opts.param };
          if (opts.command !== undefined) params.command = opts.command;
          if (Object.keys(params).length > 0) body.params = params;
          if (opts.concurrency !== undefined) body.concurrency_policy = opts.concurrency;
          if (opts.maxRetries !== undefined) body.max_retries = Number(opts.maxRetries);
          if (opts.retryDelay !== undefined) body.retry_delay_seconds = Number(opts.retryDelay);
          if (opts.timeout !== undefined) body.timeout_seconds = Number(opts.timeout);
          const op = await ctx.client.post<ScheduledOp>(
            `/tenants/${tid}/scheduled-operations`,
            body,
          );
          if (fmt === "json" || fmt === "yaml") {
            printObject(op as unknown as Record<string, unknown>, fmt);
            return;
          }
          process.stdout.write(`✓ scheduled operation created: ${op.id}\n`);
        },
      ),
    {
      flags: {
        "--type": { enum: OP_TYPES },
        "--schedule": { enum: SCHEDULE_KINDS },
        "--concurrency": { enum: CONCURRENCY },
      },
    },
  );

  withCompletion(
    g
      .command("update <id>")
      .description("update a scheduled operation")
      .option("--name <name>", "operation name")
      .option("--description <text>", "description")
      .option("--cron <expr>", "cron expression")
      .option("--timezone <tz>", "timezone")
      .option("--at <datetime>", "run time, RFC 3339")
      .option("--server <id>", "target server id")
      .option("--app <id>", "target application id")
      .option("--command <cmd>", "command to run")
      .option("--param <kv>", "extra param key=value (repeatable)", collectParam, {})
      .option("--concurrency <policy>", "SKIP|QUEUE|REPLACE")
      .option("--max-retries <n>", "max retries (0-3)")
      .option("--retry-delay <seconds>", "retry delay seconds (30-600)")
      .option("--timeout <seconds>", "timeout seconds (30-3600)")
      .action(
        async (
          id: string,
          opts: {
            name?: string;
            description?: string;
            cron?: string;
            timezone?: string;
            at?: string;
            server?: string;
            app?: string;
            command?: string;
            param: Record<string, string>;
            concurrency?: string;
            maxRetries?: string;
            retryDelay?: string;
            timeout?: string;
          },
        ) => {
          const fmt = resolveFormat(globalOutput(program));
          const ctx = await bootstrap();
          const tid = requireTenantId(ctx);
          const body: Record<string, unknown> = {};
          if (opts.name !== undefined) body.name = opts.name;
          if (opts.description !== undefined) body.description = opts.description;
          if (opts.cron !== undefined) body.cron_expression = opts.cron;
          if (opts.timezone !== undefined) body.timezone = opts.timezone;
          if (opts.at !== undefined) body.scheduled_at = opts.at;
          if (opts.server !== undefined) body.server_id = opts.server;
          if (opts.app !== undefined) body.application_id = opts.app;
          const params: Record<string, unknown> = { ...opts.param };
          if (opts.command !== undefined) params.command = opts.command;
          if (Object.keys(params).length > 0) body.params = params;
          if (opts.concurrency !== undefined) body.concurrency_policy = opts.concurrency;
          if (opts.maxRetries !== undefined) body.max_retries = Number(opts.maxRetries);
          if (opts.retryDelay !== undefined) body.retry_delay_seconds = Number(opts.retryDelay);
          if (opts.timeout !== undefined) body.timeout_seconds = Number(opts.timeout);
          const op = await ctx.client.patch<ScheduledOp>(
            `/tenants/${tid}/scheduled-operations/${id}`,
            body,
          );
          if (fmt === "json" || fmt === "yaml") {
            printObject(op as unknown as Record<string, unknown>, fmt);
            return;
          }
          process.stdout.write(`✓ scheduled operation updated: ${op.id}\n`);
        },
      ),
    {
      args: [{ slot: 0, resource: "schedule" }],
      flags: { "--concurrency": { enum: CONCURRENCY } },
    },
  );

  withCompletion(
    g
      .command("rm <id>")
      .description("delete a scheduled operation")
      .action(async (id: string) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        await ctx.client.del<void>(`/tenants/${tid}/scheduled-operations/${id}`);
        process.stdout.write(`✓ scheduled operation removed: ${id}\n`);
      }),
    { args: [{ slot: 0, resource: "schedule" }] },
  );

  withCompletion(
    g
      .command("pause <id>")
      .description("pause a scheduled operation")
      .action(async (id: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const op = await ctx.client.post<ScheduledOp>(
          `/tenants/${tid}/scheduled-operations/${id}/pause`,
        );
        if (fmt === "json" || fmt === "yaml") {
          printObject(op as unknown as Record<string, unknown>, fmt);
          return;
        }
        process.stdout.write(`✓ scheduled operation paused: ${id}\n`);
      }),
    { args: [{ slot: 0, resource: "schedule" }] },
  );

  withCompletion(
    g
      .command("resume <id>")
      .description("resume a scheduled operation")
      .action(async (id: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const op = await ctx.client.post<ScheduledOp>(
          `/tenants/${tid}/scheduled-operations/${id}/resume`,
        );
        if (fmt === "json" || fmt === "yaml") {
          printObject(op as unknown as Record<string, unknown>, fmt);
          return;
        }
        process.stdout.write(`✓ scheduled operation resumed: ${id}\n`);
      }),
    { args: [{ slot: 0, resource: "schedule" }] },
  );

  withCompletion(
    g
      .command("trigger <id>")
      .description("trigger a scheduled operation to run now")
      .action(async (id: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const run = await ctx.client.post<ScheduledRun>(
          `/tenants/${tid}/scheduled-operations/${id}/trigger`,
        );
        if (fmt === "json" || fmt === "yaml") {
          printObject(run as unknown as Record<string, unknown>, fmt);
          return;
        }
        process.stdout.write(`✓ triggered: run ${run.id}\n`);
      }),
    { args: [{ slot: 0, resource: "schedule" }] },
  );

  withCompletion(
    g
      .command("runs <id>")
      .description("list runs of a scheduled operation")
      .option("--status <status>", "filter by run status")
      .action(async (id: string, opts: { status?: string }) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const qs = opts.status ? `?status=${encodeURIComponent(opts.status)}` : "";
        const list = await ctx.client.get<ScheduledRun[]>(
          `/tenants/${tid}/scheduled-operations/${id}/runs${qs}`,
        );
        printList(
          list as unknown as Array<Record<string, unknown>>,
          [
            { key: "id", label: "ID" },
            { key: "status", label: "STATUS" },
            { key: "scheduled_for", label: "SCHEDULED FOR" },
            { key: "started_at", label: "STARTED" },
            { key: "duration_seconds", label: "DURATION(S)" },
            { key: "attempt", label: "ATTEMPT" },
          ],
          fmt,
        );
      }),
    { args: [{ slot: 0, resource: "schedule" }], flags: { "--status": { enum: RUN_STATUSES } } },
  );

  withCompletion(
    g
      .command("run <id> <runId>")
      .description("show one run of a scheduled operation")
      .action(async (id: string, runId: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const run = await ctx.client.get<Record<string, unknown>>(
          `/tenants/${tid}/scheduled-operations/${id}/runs/${runId}`,
        );
        if (fmt === "json" || fmt === "yaml") {
          printObject(run, fmt);
          return;
        }
        const { output, ...rest } = run;
        printObject(rest, fmt);
        if (typeof output === "string" && output.length > 0) {
          process.stdout.write(`\noutput:\n${output}\n`);
        }
      }),
    { args: [{ slot: 0, resource: "schedule" }] },
  );
}
