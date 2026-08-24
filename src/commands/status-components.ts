// src/commands/status-components.ts
//
// `reoclo status-pages components ...` manages the rows a status page shows.
//
// A component either mirrors another resource ("--source monitor --ref <id>")
// or is driven by hand ("--source manual"). On top of that it can carry its own
// HTTP health check, and an override that pins what visitors see regardless of
// the derived status. Every subcommand takes the page first, so the page is
// always the same argument in the same place.

import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import type { HttpClient } from "../client/http";
import { COMPONENT_SOURCE_KINDS, COMPONENT_STATUSES } from "../client/enums";
import { resolveStatusPage } from "../client/status-pages";
import { globalOutput, printList, printMutation, printObject, resolveFormat } from "../ui/output";
import { promptYesNo } from "../ui/prompt";
import { parseBool, parseEnum, parseIntFlag } from "../util/parse-flag";

interface ComponentSource {
  kind: string;
  ref_id: string | null;
}

interface ComponentHealthCheck {
  enabled: boolean;
  url: string | null;
  interval_seconds: number;
  expected_status_min: number;
  expected_status_max: number;
  timeout_seconds: number;
}

interface ComponentOverride {
  enabled: boolean;
  status: string | null;
  reason: string | null;
  suppress_auto_incidents: boolean;
  until: string | null;
}

interface ComponentAutoIncident {
  enabled: boolean;
  open_after_consecutive_failures: number;
  resolve_after_consecutive_successes: number;
}

export interface StatusComponent {
  id: string;
  status_page_id: string;
  name: string;
  position: number;
  is_visible: boolean;
  source: ComponentSource;
  health_check: ComponentHealthCheck;
  override: ComponentOverride;
  auto_incident: ComponentAutoIncident;
  state: { effective_status: string; source_status: string; source_missing: boolean };
}

function componentsPath(tid: string, pageId: string): string {
  return `/tenants/${tid}/status-pages/${pageId}/components`;
}

async function listComponents(
  client: HttpClient,
  tid: string,
  pageId: string,
): Promise<StatusComponent[]> {
  return client.get<StatusComponent[]>(`${componentsPath(tid, pageId)}/`);
}

/** Resolve a component id or exact name (case-insensitive) within one page. */
export function findComponent(
  list: readonly StatusComponent[],
  idOrName: string,
): StatusComponent | null {
  const needle = idOrName.trim().toLowerCase();
  return (
    list.find((c) => c.id === idOrName) ??
    list.find((c) => c.name.toLowerCase() === needle) ??
    null
  );
}

async function resolveComponent(
  client: HttpClient,
  tid: string,
  pageId: string,
  idOrName: string,
): Promise<StatusComponent> {
  const found = findComponent(await listComponents(client, tid, pageId), idOrName);
  if (!found) {
    const e = new Error(`component '${idOrName}' not found on this status page`) as Error & {
      exitCode: number;
    };
    e.exitCode = 5;
    throw e;
  }
  return found;
}

const COMPONENT_COLUMNS = [
  { key: "position", label: "POS" },
  { key: "name", label: "NAME" },
  { key: "kind", label: "SOURCE" },
  { key: "status", label: "STATUS" },
  { key: "visible", label: "VISIBLE" },
  { key: "id", label: "ID" },
] as const;

function toRow(c: StatusComponent): Record<string, unknown> {
  const pinned = c.override.enabled ? " (pinned)" : "";
  return {
    position: c.position,
    name: c.name,
    kind: c.source.kind,
    status: `${c.state.effective_status}${pinned}`,
    visible: c.is_visible ? "yes" : "no",
    id: c.id,
  };
}

interface HealthOpts {
  healthUrl?: string;
  healthInterval?: string;
  healthTimeout?: string;
  expectStatus?: string;
}

/** Build the health_check body from flags, or undefined when none were passed. */
function healthCheckBody(
  opts: HealthOpts,
  existing?: ComponentHealthCheck,
): Record<string, unknown> | undefined {
  const touched =
    opts.healthUrl !== undefined ||
    opts.healthInterval !== undefined ||
    opts.healthTimeout !== undefined ||
    opts.expectStatus !== undefined;
  if (!touched) return undefined;

  // The API replaces health_check wholesale, so an update has to resend the
  // fields the caller did not name.
  const body: Record<string, unknown> = {
    enabled: existing?.enabled ?? true,
    url: existing?.url ?? null,
    interval_seconds: existing?.interval_seconds ?? 60,
    expected_status_min: existing?.expected_status_min ?? 200,
    expected_status_max: existing?.expected_status_max ?? 299,
    timeout_seconds: existing?.timeout_seconds ?? 10,
  };

  if (opts.healthUrl !== undefined) {
    // An empty --health-url is how a caller turns the check back off.
    const url = opts.healthUrl.trim();
    body.url = url === "" ? null : url;
    body.enabled = url !== "";
  }
  if (opts.healthInterval !== undefined) {
    body.interval_seconds = parseIntFlag(opts.healthInterval, "--health-interval", 10, 3600);
  }
  if (opts.healthTimeout !== undefined) {
    body.timeout_seconds = parseIntFlag(opts.healthTimeout, "--health-timeout", 1, 60);
  }
  if (opts.expectStatus !== undefined) {
    const match = /^(\d{3})\s*-\s*(\d{3})$/.exec(opts.expectStatus.trim());
    if (!match) {
      const e = new Error(
        `invalid --expect-status: '${opts.expectStatus}' (expected a range like 200-299)`,
      ) as Error & { exitCode: number };
      e.exitCode = 2;
      throw e;
    }
    const min = parseIntFlag(match[1] as string, "--expect-status", 100, 599);
    const max = parseIntFlag(match[2] as string, "--expect-status", 100, 599);
    if (min > max) {
      const e = new Error(
        `invalid --expect-status: '${opts.expectStatus}' (lower bound is above the upper bound)`,
      ) as Error & { exitCode: number };
      e.exitCode = 2;
      throw e;
    }
    body.expected_status_min = min;
    body.expected_status_max = max;
  }
  return body;
}

interface AutoIncidentOpts {
  autoIncident?: string;
  openAfter?: string;
  resolveAfter?: string;
}

function autoIncidentBody(
  opts: AutoIncidentOpts,
  existing?: ComponentAutoIncident,
): Record<string, unknown> | undefined {
  const touched =
    opts.autoIncident !== undefined ||
    opts.openAfter !== undefined ||
    opts.resolveAfter !== undefined;
  if (!touched) return undefined;

  const body: Record<string, unknown> = {
    enabled: existing?.enabled ?? true,
    open_after_consecutive_failures: existing?.open_after_consecutive_failures ?? 3,
    resolve_after_consecutive_successes: existing?.resolve_after_consecutive_successes ?? 2,
  };
  if (opts.autoIncident !== undefined) {
    body.enabled = parseBool(opts.autoIncident, "--auto-incident");
  }
  if (opts.openAfter !== undefined) {
    body.open_after_consecutive_failures = parseIntFlag(opts.openAfter, "--open-after", 1, 20);
  }
  if (opts.resolveAfter !== undefined) {
    body.resolve_after_consecutive_successes = parseIntFlag(
      opts.resolveAfter,
      "--resolve-after",
      1,
      20,
    );
  }
  return body;
}

const HEALTH_FLAGS: Array<[string, string]> = [
  ["--health-url <url>", "poll this URL to derive the component's status ('' disables)"],
  ["--health-interval <seconds>", "seconds between health checks (10-3600, default 60)"],
  ["--expect-status <min-max>", "HTTP status range counted as healthy (default 200-299)"],
  ["--health-timeout <seconds>", "health check timeout in seconds (1-60, default 10)"],
];

const AUTO_INCIDENT_FLAGS: Array<[string, string]> = [
  ["--auto-incident <bool>", "open and resolve incidents automatically (default true)"],
  ["--open-after <n>", "consecutive failures before an incident opens (1-20, default 3)"],
  ["--resolve-after <n>", "consecutive successes before it resolves (1-20, default 2)"],
];

function withSharedFlags(cmd: Command): Command {
  for (const [flag, desc] of [...HEALTH_FLAGS, ...AUTO_INCIDENT_FLAGS]) cmd.option(flag, desc);
  return cmd;
}

export function registerStatusComponents(program: Command, statusPages: Command): void {
  const g = statusPages
    .command("components")
    .description("manage the components shown on a status page");

  g.command("ls <page>")
    .description("list the components on a status page")
    .action(async (page: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const sp = await resolveStatusPage(ctx.client, tid, page);
      const list = await listComponents(ctx.client, tid, sp.id);
      if (fmt === "json" || fmt === "yaml") {
        printList(list as unknown as Array<Record<string, unknown>>, ["id"], fmt);
        return;
      }
      printList(list.map(toRow), [...COMPONENT_COLUMNS], fmt);
    });

  g.command("get <page> <component>")
    .description("show one component in full")
    .action(async (page: string, component: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const sp = await resolveStatusPage(ctx.client, tid, page);
      const c = await resolveComponent(ctx.client, tid, sp.id, component);
      printObject(c as unknown as Record<string, unknown>, fmt);
    });

  withSharedFlags(
    g
      .command("add <page>")
      .description("add a component to a status page")
      .requiredOption("--name <name>", "component name shown to visitors")
      .option(
        "--source <kind>",
        `what the component watches: ${COMPONENT_SOURCE_KINDS.join("|")} (default manual)`,
      )
      .option("--ref <id>", "id of the watched resource (required unless --source manual)")
      .option("--position <n>", "sort order on the page (default 0)")
      .option("--hidden", "create the component hidden from visitors"),
  ).action(
    async (
      page: string,
      opts: HealthOpts &
        AutoIncidentOpts & {
          name: string;
          source?: string;
          ref?: string;
          position?: string;
          hidden?: boolean;
        },
    ) => {
      const kind = opts.source
        ? parseEnum(opts.source, COMPONENT_SOURCE_KINDS, "--source")
        : "manual";
      if (kind !== "manual" && !opts.ref) {
        const e = new Error(`--ref <id> is required when --source is '${kind}'`) as Error & {
          exitCode: number;
        };
        e.exitCode = 2;
        throw e;
      }
      if (kind === "manual" && opts.ref) {
        const e = new Error("--ref cannot be used with --source manual") as Error & {
          exitCode: number;
        };
        e.exitCode = 2;
        throw e;
      }

      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const sp = await resolveStatusPage(ctx.client, tid, page);

      const body: Record<string, unknown> = {
        name: opts.name,
        source: { kind, ref_id: kind === "manual" ? null : opts.ref },
      };
      if (opts.position !== undefined) {
        body.position = parseIntFlag(opts.position, "--position", 0, 10_000);
      }
      if (opts.hidden) body.is_visible = false;
      const health = healthCheckBody(opts);
      if (health) body.health_check = health;
      const autoIncident = autoIncidentBody(opts);
      if (autoIncident) body.auto_incident = autoIncident;

      const created = await ctx.client.post<StatusComponent>(
        `${componentsPath(tid, sp.id)}/`,
        body,
      );
      printMutation(
        program,
        created as unknown as Record<string, unknown>,
        `✓ component added: ${created.name} (${created.id})`,
      );
    },
  );

  withSharedFlags(
    g
      .command("update <page> <component>")
      .description("change a component's name, order, visibility, or checks")
      .option("--name <name>", "component name shown to visitors")
      .option("--position <n>", "sort order on the page")
      .option("--visible <bool>", "show the component to visitors"),
  ).action(
    async (
      page: string,
      component: string,
      opts: HealthOpts &
        AutoIncidentOpts & { name?: string; position?: string; visible?: string },
    ) => {
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const sp = await resolveStatusPage(ctx.client, tid, page);
      const current = await resolveComponent(ctx.client, tid, sp.id, component);

      const body: Record<string, unknown> = {};
      if (opts.name !== undefined) body.name = opts.name;
      if (opts.position !== undefined) {
        body.position = parseIntFlag(opts.position, "--position", 0, 10_000);
      }
      if (opts.visible !== undefined) body.is_visible = parseBool(opts.visible, "--visible");
      const health = healthCheckBody(opts, current.health_check);
      if (health) body.health_check = health;
      const autoIncident = autoIncidentBody(opts, current.auto_incident);
      if (autoIncident) body.auto_incident = autoIncident;

      if (Object.keys(body).length === 0) {
        const e = new Error("nothing to update. Pass at least one option.") as Error & {
          exitCode: number;
        };
        e.exitCode = 2;
        throw e;
      }

      const updated = await ctx.client.patch<StatusComponent>(
        `${componentsPath(tid, sp.id)}/${current.id}`,
        body,
      );
      printMutation(
        program,
        updated as unknown as Record<string, unknown>,
        `✓ component updated: ${updated.name}`,
      );
    },
  );

  g.command("pin <page> <component>")
    .description("pin what visitors see, ignoring the derived status")
    .requiredOption("--status <status>", `one of: ${COMPONENT_STATUSES.join("|")}`)
    .option("--reason <text>", "reason shown alongside the pinned status")
    .option("--until <iso8601>", "time when the pin clears automatically")
    .option("--allow-incidents", "continue to open automatic incidents during the pin")
    .action(
      async (
        page: string,
        component: string,
        opts: { status: string; reason?: string; until?: string; allowIncidents?: boolean },
      ) => {
        const pinned = parseEnum(opts.status, COMPONENT_STATUSES, "--status");
        if (opts.until !== undefined && Number.isNaN(Date.parse(opts.until))) {
          const e = new Error(
            `invalid --until: '${opts.until}' (expected an ISO 8601 timestamp)`,
          ) as Error & { exitCode: number };
          e.exitCode = 2;
          throw e;
        }
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const sp = await resolveStatusPage(ctx.client, tid, page);
        const current = await resolveComponent(ctx.client, tid, sp.id, component);
        const updated = await ctx.client.patch<StatusComponent>(
          `${componentsPath(tid, sp.id)}/${current.id}`,
          {
            override: {
              enabled: true,
              status: pinned,
              reason: opts.reason ?? null,
              suppress_auto_incidents: !opts.allowIncidents,
              until: opts.until ?? null,
            },
          },
        );
        printMutation(
          program,
          updated as unknown as Record<string, unknown>,
          `✓ ${updated.name} pinned to ${pinned}`,
        );
      },
    );

  g.command("unpin <page> <component>")
    .description("clear a pinned status and go back to the derived one")
    .action(async (page: string, component: string) => {
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const sp = await resolveStatusPage(ctx.client, tid, page);
      const current = await resolveComponent(ctx.client, tid, sp.id, component);
      const updated = await ctx.client.patch<StatusComponent>(
        `${componentsPath(tid, sp.id)}/${current.id}`,
        {
          override: {
            enabled: false,
            status: null,
            reason: null,
            suppress_auto_incidents: true,
            until: null,
          },
        },
      );
      printMutation(
        program,
        updated as unknown as Record<string, unknown>,
        `✓ ${updated.name} unpinned`,
      );
    });

  g.command("reorder <page> <components...>")
    .description("set the display order of the components on a page")
    .action(async (page: string, components: string[]) => {
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const sp = await resolveStatusPage(ctx.client, tid, page);
      const all = await listComponents(ctx.client, tid, sp.id);

      const resolved = components.map((token) => {
        const found = findComponent(all, token);
        if (!found) {
          const e = new Error(`component '${token}' not found on this status page`) as Error & {
            exitCode: number;
          };
          e.exitCode = 5;
          throw e;
        }
        return found;
      });
      const seen = new Set<string>();
      for (const c of resolved) {
        if (seen.has(c.id)) {
          const e = new Error(`component '${c.name}' listed more than once`) as Error & {
            exitCode: number;
          };
          e.exitCode = 2;
          throw e;
        }
        seen.add(c.id);
      }
      // Components left out keep their relative order, after the listed ones.
      const rest = all
        .filter((c) => !seen.has(c.id))
        .sort((a, b) => a.position - b.position);

      const ordered = [...resolved, ...rest];
      for (const [index, c] of ordered.entries()) {
        if (c.position === index) continue;
        await ctx.client.patch<StatusComponent>(`${componentsPath(tid, sp.id)}/${c.id}`, {
          position: index,
        });
      }
      printMutation(
        program,
        { status_page_id: sp.id, order: ordered.map((c) => c.name) },
        `✓ reordered ${ordered.length} component(s): ${ordered.map((c) => c.name).join(", ")}`,
      );
    });

  g.command("rm <page> <component>")
    .description("remove a component from a status page")
    .option("--yes", "skip confirmation prompt")
    .action(async (page: string, component: string, opts: { yes?: boolean }) => {
      if (!opts.yes) {
        const ok = await promptYesNo(`remove component ${component}? [y/N]: `);
        if (!ok) {
          process.stderr.write("aborted (pass --yes to confirm non-interactively)\n");
          process.exit(1);
        }
      }
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const sp = await resolveStatusPage(ctx.client, tid, page);
      const current = await resolveComponent(ctx.client, tid, sp.id, component);
      await ctx.client.del<void>(`${componentsPath(tid, sp.id)}/${current.id}`);
      printMutation(
        program,
        { id: current.id, name: current.name },
        `✓ component removed: ${current.name}`,
      );
    });
}
