// src/commands/monitors.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { withCompletion } from "../client/command-meta";
import { cacheList } from "../completion/populate";
import { globalOutput, printList, printMutation, printObject, resolveFormat } from "../ui/output";

interface Monitor {
  id: string;
  name: string;
  url: string;
  status: string;
  check_interval_seconds: number;
}

const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/** Parse `--expect-status` (`200` or `200-299`) into the API's min/max pair. */
export function parseExpectStatus(input: string): {
  expected_status_min: number;
  expected_status_max: number;
} {
  const m = input.match(/^(\d{3})(?:-(\d{3}))?$/);
  if (!m) throw new Error(`invalid --expect-status '${input}' (use e.g. 200 or 200-299)`);
  const min = Number(m[1]);
  const max = m[2] !== undefined ? Number(m[2]) : min;
  if (min > max) throw new Error(`invalid --expect-status '${input}' (min ${min} > max ${max})`);
  return { expected_status_min: min, expected_status_max: max };
}

/** Normalise and validate `--method`. */
export function parseMethod(input: string): string {
  const up = input.toUpperCase();
  if (!(HTTP_METHODS as readonly string[]).includes(up)) {
    throw new Error(`invalid --method '${input}' (one of ${HTTP_METHODS.join(", ")})`);
  }
  return up;
}

/** Parse a `--header "Name: value"` flag into the API header shape (cleartext). */
export function parseHeaderFlag(input: string): {
  name: string;
  value: string;
  is_secret: boolean;
} {
  const idx = input.indexOf(":");
  const name = idx > 0 ? input.slice(0, idx).trim() : "";
  if (!name) throw new Error(`invalid --header '${input}' (use "Name: value")`);
  return { name, value: input.slice(idx + 1).trim(), is_secret: false };
}

/** Collect a repeatable option into an array (commander reducer). */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

interface MonitorFieldOpts {
  name?: string;
  url?: string;
  interval?: string;
  checkPath?: string;
  method?: string;
  timeout?: string;
  expectStatus?: string;
  mustContain?: string;
  header?: string[];
}

/** Build a monitor create/update body from CLI flags. Only supplied fields are
 *  included, so the same builder serves the PATCH (update) path. */
export function buildMonitorBody(opts: MonitorFieldOpts): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (opts.name !== undefined) body.name = opts.name;
  if (opts.url !== undefined) body.url = opts.url;
  if (opts.interval !== undefined) body.check_interval_seconds = Number(opts.interval);
  if (opts.checkPath !== undefined) body.check_path = opts.checkPath;
  if (opts.method !== undefined) body.method = parseMethod(opts.method);
  if (opts.timeout !== undefined) body.timeout_seconds = Number(opts.timeout);
  if (opts.expectStatus !== undefined) Object.assign(body, parseExpectStatus(opts.expectStatus));
  if (opts.mustContain !== undefined) body.response_must_contain = opts.mustContain;
  if (opts.header && opts.header.length > 0) body.headers = opts.header.map(parseHeaderFlag);
  return body;
}

export function registerMonitors(program: Command): void {
  const g = program.command("monitors").description("manage uptime monitors");

  g.command("ls")
    .description("list uptime monitors")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const list = await ctx.client.get<Monitor[]>(`/tenants/${tid}/monitors`);
      cacheList("monitors", list);
      printList(
        list as unknown as Array<Record<string, unknown>>,
        [
          { key: "id", label: "ID" },
          { key: "name", label: "NAME" },
          { key: "url", label: "URL" },
          { key: "status", label: "STATUS" },
          { key: "check_interval_seconds", label: "INTERVAL(S)" },
        ],
        fmt,
      );
    });

  withCompletion(
    g
      .command("get <id>")
      .description("show one monitor")
      .action(async (id: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const m = await ctx.client.get<Record<string, unknown>>(
          `/tenants/${tid}/monitors/${id}`,
        );
        printObject(m, fmt);
      }),
    { args: [{ slot: 0, resource: "monitors" }] },
  );

  g.command("create")
    .description("create an uptime monitor")
    .requiredOption("--name <name>", "monitor name")
    .requiredOption("--url <url>", "URL to probe")
    .option("--interval <seconds>", "check interval in seconds (10-3600)")
    .option("--check-path <path>", "request path appended to the URL, e.g. /health")
    .option("--method <method>", `HTTP method (${HTTP_METHODS.join(", ")})`)
    .option("--timeout <seconds>", "request timeout in seconds (1-120)")
    .option("--expect-status <range>", "acceptable status, single or range, e.g. 200 or 200-299")
    .option("--must-contain <text>", "require this substring in the response body")
    .option("--header <header>", "request header 'Name: value' (repeatable)", collect, [] as string[])
    .action(async (opts: MonitorFieldOpts) => {
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const body = buildMonitorBody(opts);
      const m = await ctx.client.post<Monitor>(`/tenants/${tid}/monitors`, body);
      printMutation(program, m as unknown as Record<string, unknown>, `✓ monitor created: ${m.id}`);
    });

  withCompletion(
    g
      .command("update <id>")
      .description("update an uptime monitor")
      .option("--name <name>", "monitor name")
      .option("--url <url>", "URL to probe")
      .option("--interval <seconds>", "check interval in seconds (10-3600)")
      .option("--check-path <path>", "request path appended to the URL, e.g. /health")
      .option("--method <method>", `HTTP method (${HTTP_METHODS.join(", ")})`)
      .option("--timeout <seconds>", "request timeout in seconds (1-120)")
      .option("--expect-status <range>", "acceptable status, single or range, e.g. 200 or 200-299")
      .option("--must-contain <text>", "require this substring in the response body")
      .option(
        "--header <header>",
        "request header 'Name: value' (repeatable; replaces all headers)",
        collect,
        [] as string[],
      )
      .action(async (id: string, opts: MonitorFieldOpts) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const body = buildMonitorBody(opts);
        const m = await ctx.client.patch<Monitor>(`/tenants/${tid}/monitors/${id}`, body);
        printMutation(program, m as unknown as Record<string, unknown>, `✓ monitor updated: ${m.id}`);
      }),
    { args: [{ slot: 0, resource: "monitors" }] },
  );

  withCompletion(
    g
      .command("pause <id>")
      .description("pause a monitor")
      .action(async (id: string) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const m = await ctx.client.post<Monitor>(`/tenants/${tid}/monitors/${id}/pause`);
        printMutation(program, m as unknown as Record<string, unknown>, `✓ monitor paused: ${id}`);
      }),
    { args: [{ slot: 0, resource: "monitors" }] },
  );

  withCompletion(
    g
      .command("resume <id>")
      .description("resume a monitor")
      .action(async (id: string) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const m = await ctx.client.post<Monitor>(`/tenants/${tid}/monitors/${id}/resume`);
        printMutation(program, m as unknown as Record<string, unknown>, `✓ monitor resumed: ${id}`);
      }),
    { args: [{ slot: 0, resource: "monitors" }] },
  );

  withCompletion(
    g
      .command("rm <id>")
      .description("delete a monitor")
      .action(async (id: string) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        await ctx.client.del<void>(`/tenants/${tid}/monitors/${id}`);
        process.stdout.write(`✓ monitor removed: ${id}\n`);
      }),
    { args: [{ slot: 0, resource: "monitors" }] },
  );
}
