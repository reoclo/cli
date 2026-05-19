// src/commands/incidents.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { withCompletion } from "../client/command-meta";
import { cacheList } from "../completion/populate";
import { globalOutput, printList, printObject, resolveFormat } from "../ui/output";

const SEVERITIES = ["minor", "major", "critical"];
const STATES = ["investigating", "identified", "monitoring", "resolved"];

interface Incident {
  id: string;
  title: string;
  severity: string;
  state: string;
  started_at: string;
}

interface IncidentUpdate {
  message: string;
  state: string | null;
  created_at: string;
}

export function registerIncidents(program: Command): void {
  const g = program.command("incidents").description("manage incidents");

  withCompletion(
    g
      .command("ls")
      .description("list incidents")
      .option("--state <state>", "filter by state")
      .action(async (opts: { state?: string }) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const qs = opts.state ? `?state=${encodeURIComponent(opts.state)}` : "";
        const list = await ctx.client.get<Incident[]>(`/tenants/${tid}/incidents/${qs}`);
        cacheList("incidents", list);
        printList(
          list as unknown as Array<Record<string, unknown>>,
          [
            { key: "id", label: "ID" },
            { key: "title", label: "TITLE" },
            { key: "severity", label: "SEVERITY" },
            { key: "state", label: "STATE" },
            { key: "started_at", label: "STARTED" },
          ],
          fmt,
        );
      }),
    { flags: { "--state": { enum: STATES } } },
  );

  withCompletion(
    g
      .command("get <id>")
      .description("show an incident with its update history")
      .action(async (id: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const incident = await ctx.client.get<Record<string, unknown>>(
          `/tenants/${tid}/incidents/${id}`,
        );
        const updates = await ctx.client.get<IncidentUpdate[]>(
          `/tenants/${tid}/incidents/${id}/updates`,
        );
        if (fmt === "json" || fmt === "yaml") {
          printObject({ ...incident, updates }, fmt);
          return;
        }
        printObject(incident, fmt);
        process.stdout.write(`\nupdates (${updates.length}):\n`);
        for (const u of updates) {
          const state = u.state ? ` [${u.state}]` : "";
          process.stdout.write(`  ${u.created_at}${state} ${u.message}\n`);
        }
      }),
    { args: [{ slot: 0, resource: "incidents" }] },
  );

  withCompletion(
    g
      .command("create")
      .description("create an incident")
      .requiredOption("--title <title>", "incident title")
      .option("--severity <severity>", "minor|major|critical")
      .option("--summary <text>", "incident summary")
      .option("--status-page <id>", "attach to a status page")
      .action(
        async (opts: {
          title: string;
          severity?: string;
          summary?: string;
          statusPage?: string;
        }) => {
          const fmt = resolveFormat(globalOutput(program));
          const ctx = await bootstrap();
          const tid = requireTenantId(ctx);
          const body: Record<string, unknown> = { title: opts.title };
          if (opts.severity !== undefined) body.severity = opts.severity;
          if (opts.summary !== undefined) body.summary = opts.summary;
          if (opts.statusPage !== undefined) body.status_page_id = opts.statusPage;
          const inc = await ctx.client.post<Incident>(`/tenants/${tid}/incidents/`, body);
          if (fmt === "json" || fmt === "yaml") {
            printObject(inc as unknown as Record<string, unknown>, fmt);
            return;
          }
          process.stdout.write(`✓ incident created: ${inc.id}\n`);
        },
      ),
    { flags: { "--severity": { enum: SEVERITIES } } },
  );

  withCompletion(
    g
      .command("update <id>")
      .description("update an incident (--state resolved resolves it)")
      .option("--state <state>", "investigating|identified|monitoring|resolved")
      .option("--severity <severity>", "minor|major|critical")
      .option("--title <title>", "incident title")
      .option("--summary <text>", "incident summary")
      .action(
        async (
          id: string,
          opts: { state?: string; severity?: string; title?: string; summary?: string },
        ) => {
          const fmt = resolveFormat(globalOutput(program));
          const ctx = await bootstrap();
          const tid = requireTenantId(ctx);
          const body: Record<string, unknown> = {};
          if (opts.state !== undefined) body.state = opts.state;
          if (opts.severity !== undefined) body.severity = opts.severity;
          if (opts.title !== undefined) body.title = opts.title;
          if (opts.summary !== undefined) body.summary = opts.summary;
          const inc = await ctx.client.patch<Incident>(`/tenants/${tid}/incidents/${id}`, body);
          if (fmt === "json" || fmt === "yaml") {
            printObject(inc as unknown as Record<string, unknown>, fmt);
            return;
          }
          process.stdout.write(`✓ incident updated: ${inc.id}\n`);
        },
      ),
    {
      args: [{ slot: 0, resource: "incidents" }],
      flags: { "--state": { enum: STATES }, "--severity": { enum: SEVERITIES } },
    },
  );

  withCompletion(
    g
      .command("add-update <id>")
      .description("append a progress update to an incident")
      .requiredOption("--message <text>", "update message")
      .option("--state <state>", "also change the incident state")
      .action(async (id: string, opts: { message: string; state?: string }) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const body: Record<string, unknown> = { message: opts.message };
        if (opts.state !== undefined) body.state = opts.state;
        const u = await ctx.client.post<Record<string, unknown>>(
          `/tenants/${tid}/incidents/${id}/updates`,
          body,
        );
        if (fmt === "json" || fmt === "yaml") {
          printObject(u, fmt);
          return;
        }
        process.stdout.write(`✓ update posted to incident ${id}\n`);
      }),
    {
      args: [{ slot: 0, resource: "incidents" }],
      flags: { "--state": { enum: STATES } },
    },
  );
}
