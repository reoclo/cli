// src/commands/traffic.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { withCompletion } from "../client/command-meta";
import { resolveApp, resolveDomain } from "../client/resolve";
import { globalOutput, printList, printObject, resolveFormat, type OutputFormat } from "../ui/output";
import { isTTY } from "../ui/tty";
import { badUsage, parseEnum, parseIntFlag } from "../util/parse-flag";
import {
  ROUTE_SORTS,
  TRAFFIC_RANGES,
  routeRows,
  routesFooter,
  summaryRows,
  type TrafficRoutesBody,
  type TrafficSummaryBody,
} from "../util/traffic-format";

interface SubjectOpts {
  app?: string;
  domain?: string;
}

interface Subject {
  param: [name: string, id: string];
  label: string;
}

function requireOneSubject(opts: SubjectOpts): void {
  if (opts.app !== undefined && opts.domain !== undefined) {
    throw badUsage("pass only one of --app and --domain");
  }
  if (opts.app === undefined && opts.domain === undefined) {
    throw badUsage("pass --app <id|name> or --domain <fqdn|id>");
  }
}

async function resolveSubject(
  ctx: Awaited<ReturnType<typeof bootstrap>>,
  tid: string,
  opts: SubjectOpts,
): Promise<Subject> {
  if (opts.app !== undefined) {
    return { param: ["application_id", await resolveApp(ctx.client, tid, opts.app)], label: opts.app };
  }
  const domain = opts.domain ?? "";
  return { param: ["domain_id", await resolveDomain(ctx.client, tid, domain)], label: domain };
}

function query(subject: Subject, extra: Record<string, string | undefined>): string {
  const q = new URLSearchParams([subject.param]);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) q.set(k, v);
  return q.toString();
}

function printSummary(body: TrafficSummaryBody, heading: string): void {
  process.stdout.write(`${heading}\n`);
  printList(
    summaryRows(body.current, body.previous) as unknown as Array<Record<string, unknown>>,
    [
      { key: "metric", label: "METRIC" },
      { key: "current", label: "CURRENT" },
      { key: "previous", label: "PREVIOUS" },
      { key: "change", label: "CHANGE" },
    ],
    "text",
  );
}

function printFrame(body: unknown, fmt: OutputFormat): void {
  if (fmt === "json") process.stdout.write(`${JSON.stringify(body)}\n`);
  else if (fmt === "yaml") {
    process.stdout.write("---\n");
    printObject(body as Record<string, unknown>, "yaml");
  }
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function registerTraffic(program: Command): void {
  const g = program.command("traffic").description("request traffic for an application or domain");

  const subjectFlags = { "--app": "apps", "--domain": "domains" } as const;
  const withSubject = (cmd: Command): Command =>
    cmd
      .option("--app <id|name>", "the application to read")
      .option("--domain <fqdn|id>", "the domain to read");
  const rangeOption = (cmd: Command): Command =>
    cmd.option("--range <range>", `time range: ${TRAFFIC_RANGES.join("|")}`, "1h");

  withCompletion(
    rangeOption(withSubject(g.command("summary")))
      .description("requests, errors and latency, with the change against the previous period")
      .option("--route <template>", "only this route, for example /users/:id (needs --method)")
      .option("--method <verb>", "the HTTP method of --route")
      .action(async (opts: SubjectOpts & { range: string; route?: string; method?: string }) => {
        requireOneSubject(opts);
        const range = parseEnum(opts.range, TRAFFIC_RANGES, "--range");
        if ((opts.route === undefined) !== (opts.method === undefined)) {
          throw badUsage("--route and --method go together");
        }
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const subject = await resolveSubject(ctx, tid, opts);
        const qs = query(subject, {
          range,
          route: opts.route,
          method: opts.method?.toUpperCase(),
        });
        const body = await ctx.client.get<TrafficSummaryBody>(
          `/tenants/${tid}/traffic/summary?${qs}`,
        );
        if (fmt !== "text") {
          printObject(body as unknown as Record<string, unknown>, fmt);
          return;
        }
        const what =
          opts.route !== undefined
            ? `${opts.method?.toUpperCase() ?? ""} ${opts.route} on ${subject.label}`
            : subject.label;
        printSummary(body, `Traffic for ${what}, last ${range} (change against the previous ${range})`);
      }),
    { flags: { ...subjectFlags, "--range": { enum: [...TRAFFIC_RANGES] } } },
  );

  withCompletion(
    rangeOption(withSubject(g.command("routes")))
      .description("the busiest routes, with errors and latency")
      .option("--sort <key>", `order by ${ROUTE_SORTS.join("|")}`, "requests")
      .option("--limit <n>", "routes to list (1 to 200)", "50")
      .action(async (opts: SubjectOpts & { range: string; sort: string; limit: string }) => {
        requireOneSubject(opts);
        const range = parseEnum(opts.range, TRAFFIC_RANGES, "--range");
        const sort = parseEnum(opts.sort, ROUTE_SORTS, "--sort");
        const limit = parseIntFlag(opts.limit, "--limit", 1, 200);
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const subject = await resolveSubject(ctx, tid, opts);
        const qs = query(subject, { range, sort, limit: String(limit) });
        const body = await ctx.client.get<TrafficRoutesBody>(`/tenants/${tid}/traffic/routes?${qs}`);
        if (fmt !== "text") {
          printObject(body as unknown as Record<string, unknown>, fmt);
          return;
        }
        if (body.items.length === 0) {
          process.stdout.write(`No routed requests for ${subject.label} in the last ${range}.\n`);
        } else {
          printList(
            routeRows(body.items) as unknown as Array<Record<string, unknown>>,
            [
              { key: "method", label: "METHOD" },
              { key: "route", label: "ROUTE" },
              { key: "requests", label: "REQUESTS" },
              { key: "rps", label: "REQ/S" },
              { key: "errors", label: "5XX" },
              { key: "p50", label: "P50" },
              { key: "p95", label: "P95" },
              { key: "p99", label: "P99" },
              { key: "bytes", label: "BYTES OUT" },
            ],
            "text",
          );
        }
        const footer = routesFooter(body);
        if (footer !== null) process.stdout.write(`${footer}\n`);
      }),
    {
      flags: {
        ...subjectFlags,
        "--range": { enum: [...TRAFFIC_RANGES] },
        "--sort": { enum: [...ROUTE_SORTS] },
      },
    },
  );

  withCompletion(
    withSubject(g.command("watch"))
      .description("redraw the last 15 minutes every few seconds until Ctrl-C")
      .option("--interval <seconds>", "seconds between refreshes (1 to 3600)", "5")
      .action(async (opts: SubjectOpts & { interval: string }) => {
        requireOneSubject(opts);
        const intervalSeconds = parseIntFlag(opts.interval, "--interval", 1, 3600);
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const subject = await resolveSubject(ctx, tid, opts);
        const path = `/tenants/${tid}/traffic/summary?${query(subject, { range: "15m" })}`;

        const stop = new AbortController();
        const onSigint = (): void => stop.abort();
        process.once("SIGINT", onSigint);
        try {
          let first = true;
          while (!stop.signal.aborted) {
            const body = await ctx.client.get<TrafficSummaryBody>(path);
            if (stop.signal.aborted) break;
            if (fmt === "text") {
              if (isTTY()) process.stdout.write("\x1b[2J\x1b[H");
              else if (!first) process.stdout.write("\n");
              const at = new Date().toISOString().slice(11, 19);
              printSummary(
                body,
                `Traffic for ${subject.label}, last 15m, at ${at} UTC (every ${intervalSeconds}s, Ctrl-C to stop)`,
              );
            } else {
              printFrame(body, fmt);
            }
            first = false;
            await sleepUnlessAborted(intervalSeconds * 1000, stop.signal);
          }
        } finally {
          process.off("SIGINT", onSigint);
        }
      }),
    { flags: subjectFlags },
  );
}
