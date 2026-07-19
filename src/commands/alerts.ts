// src/commands/alerts.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import type { ResolvedContext } from "../client/bootstrap";
import { withCompletion } from "../client/command-meta";
import { cacheList } from "../completion/populate";
import { globalOutput, printList, printMutation, printObject, resolveFormat } from "../ui/output";

const ALERT_STATES = ["firing", "acknowledged", "resolved"];
const ALERT_SEVERITIES = ["info", "warn", "critical"];
const ALERT_CODES = [
  "ssh_check_failed",
  "monitor_down",
  "ssl_expiry_warn",
  "ssl_expiry_critical",
  "ssl_invalid",
  "dns_mismatch",
  "schedule_missed",
  "schedule_failed",
  "app_deploy_failed",
  "app_unhealthy",
  "server_disk_warn",
];

interface AlertCatalogEntry {
  code: string;
  enabled: boolean;
  resource_kind: string;
  severity_warn: number | null;
  severity_critical: number | null;
  clear_threshold: number | null;
  consecutive_to_fire: number;
  consecutive_to_clear: number;
}

interface AlertInstance {
  id: string;
  alert_code: string;
  resource_kind: string;
  resource_id: string;
  state: string;
  severity: string;
  fired_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
}

interface AlertMute {
  id: string;
  alert_code: string | null;
  resource_kind: string | null;
  resource_id: string | null;
  expires_at: string | null;
  reason: string;
}

export function registerAlerts(program: Command): void {
  const g = program.command("alerts").description("manage alerts");

  // ---------------------------------------------------------------------------
  // catalog
  // ---------------------------------------------------------------------------

  const catalog = g.command("catalog").description("manage alert catalog");

  catalog
    .command("ls")
    .description("list alert catalog entries")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const list = await ctx.client.get<AlertCatalogEntry[]>(`/tenants/${tid}/alerts/catalog`);
      cacheList("alert-codes", list);
      printList(
        list as unknown as Array<Record<string, unknown>>,
        [
          { key: "code", label: "CODE" },
          { key: "resource_kind", label: "KIND" },
          { key: "enabled", label: "ENABLED" },
          { key: "consecutive_to_fire", label: "FIRE_AFTER" },
          { key: "consecutive_to_clear", label: "CLEAR_AFTER" },
        ],
        fmt,
      );
    });

  withCompletion(
    catalog
      .command("get <code>")
      .description("show one catalog entry")
      .action(async (code: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const entry = await ctx.client.get<Record<string, unknown>>(
          `/tenants/${tid}/alerts/catalog/${code}`,
        );
        printObject(entry, fmt);
      }),
    { args: [{ slot: 0, resource: "alert-codes" }] },
  );

  withCompletion(
    catalog
      .command("update <code>")
      .description("update a catalog entry")
      .option("--warn <n>", "warn threshold")
      .option("--critical <n>", "critical threshold")
      .option("--clear <n>", "clear threshold")
      .option("--consecutive-to-fire <n>", "consecutive failures before firing")
      .option("--consecutive-to-clear <n>", "consecutive passes before clearing")
      .option("--enabled <bool>", "enable or disable (true|false)")
      .action(
        async (
          code: string,
          opts: {
            warn?: string;
            critical?: string;
            clear?: string;
            consecutiveToFire?: string;
            consecutiveToClear?: string;
            enabled?: string;
          },
        ) => {
          const ctx = await bootstrap();
          const tid = requireTenantId(ctx);
          const body: Record<string, unknown> = {};
          if (opts.warn !== undefined) body.severity_warn = Number(opts.warn);
          if (opts.critical !== undefined) body.severity_critical = Number(opts.critical);
          if (opts.clear !== undefined) body.clear_threshold = Number(opts.clear);
          if (opts.consecutiveToFire !== undefined)
            body.consecutive_to_fire = Number(opts.consecutiveToFire);
          if (opts.consecutiveToClear !== undefined)
            body.consecutive_to_clear = Number(opts.consecutiveToClear);
          if (opts.enabled !== undefined) body.enabled = opts.enabled !== "false";
          const entry = await ctx.client.patch<Record<string, unknown>>(
            `/tenants/${tid}/alerts/catalog/${code}`,
            body,
          );
          printMutation(program, entry, `✓ catalog entry updated: ${code}`);
        },
      ),
    { args: [{ slot: 0, resource: "alert-codes" }] },
  );

  // ---------------------------------------------------------------------------
  // instances: list / get / ack / resolve / history
  // ---------------------------------------------------------------------------

  withCompletion(
    g
      .command("list")
      .description("list alert instances")
      .option("--state <state>", "filter by state (firing|acknowledged|resolved)")
      .option("--severity <severity>", "filter by severity (info|warn|critical)")
      .option("--resource <kind:id>", "filter by resource (e.g. server:my-server)")
      .option("--since <duration>", "filter to instances fired within duration (for example 24h, 7d)")
      .action(
        async (opts: {
          state?: string;
          severity?: string;
          resource?: string;
          since?: string;
        }) => {
          const fmt = resolveFormat(globalOutput(program));
          const ctx = await bootstrap();
          const tid = requireTenantId(ctx);
          const params = new URLSearchParams();
          if (opts.state) params.set("state", opts.state);
          if (opts.severity) params.set("severity", opts.severity);
          if (opts.resource) {
            const [kind, id] = opts.resource.split(":");
            if (kind) params.set("resource_kind", kind);
            if (id) params.set("resource_id", id);
          }
          if (opts.since) params.set("since", opts.since);
          const qs = params.toString() ? `?${params.toString()}` : "";
          const list = await ctx.client.get<AlertInstance[]>(
            `/tenants/${tid}/alerts/instances${qs}`,
          );
          cacheList("alert-instances", list);
          printList(
            list as unknown as Array<Record<string, unknown>>,
            [
              { key: "id", label: "ID" },
              { key: "alert_code", label: "CODE" },
              { key: "severity", label: "SEVERITY" },
              { key: "state", label: "STATE" },
              { key: "resource_kind", label: "KIND" },
              { key: "resource_id", label: "RESOURCE" },
              { key: "fired_at", label: "FIRED" },
            ],
            fmt,
          );
        },
      ),
    {
      flags: {
        "--state": { enum: ALERT_STATES },
        "--severity": { enum: ALERT_SEVERITIES },
      },
    },
  );

  withCompletion(
    g
      .command("get <instance-id>")
      .description("show one alert instance with severity history")
      .action(async (instanceId: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const instance = await ctx.client.get<Record<string, unknown>>(
          `/tenants/${tid}/alerts/instances/${instanceId}`,
        );
        printObject(instance, fmt);
      }),
    { args: [{ slot: 0, resource: "alert-instances" }] },
  );

  withCompletion(
    g
      .command("ack <instance-id>")
      .description("acknowledge an alert instance")
      .option("--note <text>", "acknowledgment note")
      .action(async (instanceId: string, opts: { note?: string }) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const body: Record<string, unknown> = {};
        if (opts.note !== undefined) body.note = opts.note;
        const result = await ctx.client.post<Record<string, unknown>>(
          `/tenants/${tid}/alerts/instances/${instanceId}/acknowledge`,
          body,
        );
        printMutation(program, result, `✓ alert acknowledged: ${instanceId}`);
      }),
    { args: [{ slot: 0, resource: "alert-instances" }] },
  );

  withCompletion(
    g
      .command("resolve <instance-id>")
      .description("resolve an alert instance")
      .requiredOption("--note <text>", "resolution note")
      .action(async (instanceId: string, opts: { note: string }) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const result = await ctx.client.post<Record<string, unknown>>(
          `/tenants/${tid}/alerts/instances/${instanceId}/resolve`,
          { note: opts.note },
        );
        printMutation(program, result, `✓ alert resolved: ${instanceId}`);
      }),
    { args: [{ slot: 0, resource: "alert-instances" }] },
  );

  withCompletion(
    g
      .command("history")
      .description("list recently resolved alerts (sugar for list --state=resolved)")
      .option("--since <duration>", "look-back window (default: 7d)")
      .action(async (opts: { since?: string }) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const since = opts.since ?? "7d";
        const list = await ctx.client.get<AlertInstance[]>(
          `/tenants/${tid}/alerts/instances?state=resolved&since=${encodeURIComponent(since)}`,
        );
        printList(
          list as unknown as Array<Record<string, unknown>>,
          [
            { key: "id", label: "ID" },
            { key: "alert_code", label: "CODE" },
            { key: "severity", label: "SEVERITY" },
            { key: "resource_kind", label: "KIND" },
            { key: "resource_id", label: "RESOURCE" },
            { key: "resolved_at", label: "RESOLVED" },
          ],
          fmt,
        );
      }),
    {},
  );

  // ---------------------------------------------------------------------------
  // mutes
  // ---------------------------------------------------------------------------

  withCompletion(
    g
      .command("mute [alert-code]")
      .description("mute an alert code for a resource (omit code to mute all alerts)")
      .requiredOption("--resource <kind:id>", "resource to mute (e.g. server:my-server)")
      .requiredOption("--for <duration>", "mute duration (for example 2h, 7d) or 'indefinite'")
      .requiredOption("--reason <text>", "reason for muting")
      .option("--confirm", "required when --for indefinite")
      .action(
        async (
          alertCode: string | undefined,
          opts: { resource: string; for: string; reason: string; confirm?: boolean },
        ) => {
          if (opts.for === "indefinite" && !opts.confirm) {
            process.stderr.write(
              "Error: --confirm is required when --for indefinite\n",
            );
            process.exit(1);
          }
          const ctx = await bootstrap();
          const tid = requireTenantId(ctx);
          const [resourceKind, resourceId] = opts.resource.split(":");
          const body: Record<string, unknown> = {
            reason: opts.reason,
            resource_kind: resourceKind,
            resource_id: resourceId,
          };
          if (alertCode) body.alert_code = alertCode;
          if (opts.for !== "indefinite") {
            // Convert duration string to ISO datetime
            body.expires_at = resolveMuteExpiry(opts.for);
          }
          const mute = await ctx.client.post<{ id?: string } & Record<string, unknown>>(
            `/tenants/${tid}/alerts/mutes`,
            body,
          );
          printMutation(program, mute, `✓ mute created: ${mute.id ?? ""}`);
        },
      ),
    { args: [{ slot: 0, resource: "alert-codes" }] },
  );

  const mutes = g.command("mutes").description("manage alert mutes");

  mutes
    .command("list")
    .description("list active mutes")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const list = await ctx.client.get<AlertMute[]>(`/tenants/${tid}/alerts/mutes`);
      cacheList("alert-mutes", list);
      printList(
        list as unknown as Array<Record<string, unknown>>,
        [
          { key: "id", label: "ID" },
          { key: "alert_code", label: "CODE" },
          { key: "resource_kind", label: "KIND" },
          { key: "resource_id", label: "RESOURCE" },
          { key: "expires_at", label: "EXPIRES" },
          { key: "reason", label: "REASON" },
        ],
        fmt,
      );
    });

  withCompletion(
    g
      .command("unmute <mute-id>")
      .description("remove a mute")
      .action(async (muteId: string) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        await ctx.client.del<void>(`/tenants/${tid}/alerts/mutes/${muteId}`);
        process.stdout.write(`✓ mute removed: ${muteId}\n`);
      }),
    { args: [{ slot: 0, resource: "alert-mutes" }] },
  );

  // ---------------------------------------------------------------------------
  // routing
  // ---------------------------------------------------------------------------

  const routing = g.command("routing").description("manage alert routing");

  routing
    .command("get")
    .description("show alert routing configuration")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const config = await ctx.client.get<Record<string, unknown>>(
        `/tenants/${tid}/alerts/routing`,
      );
      printObject(config, fmt);
    });

  routing
    .command("set")
    .description("replace alert routing configuration from a YAML/JSON file")
    .requiredOption("--from-file <path>", "path to routing YAML or JSON file")
    .action(async (opts: { fromFile: string }) => {
      const fs = await import("node:fs/promises");
      const raw = await fs.readFile(opts.fromFile, "utf8");
      let body: Record<string, unknown>;
      if (opts.fromFile.endsWith(".json")) {
        body = JSON.parse(raw) as Record<string, unknown>;
      } else {
        // Basic YAML → JSON via the built-in parser isn't available; use JSON
        // if the content parses as JSON, otherwise let the server validate.
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          process.stderr.write(
            "Error: only JSON files are supported for --from-file (YAML support requires a YAML library)\n",
          );
          process.exit(1);
        }
      }
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const result = await ctx.client.put<Record<string, unknown>>(
        `/tenants/${tid}/alerts/routing`,
        body,
      );
      printMutation(program, result, "✓ alert routing updated");
    });

  withCompletion(
    routing
      .command("override <alert-code>")
      .description("set per-code routing overrides")
      .option("--critical <channels>", "comma-separated channels for critical (email, channel:<id>, or '' to clear)")
      .option("--warn <channels>", "comma-separated channels for warn")
      .option("--info <channels>", "comma-separated channels for info")
      .action(
        async (
          alertCode: string,
          opts: { critical?: string; warn?: string; info?: string },
        ) => {
          const ctx = await bootstrap();
          const tid = requireTenantId(ctx);
          const routes: Record<string, unknown> = {};
          if (opts.critical !== undefined) routes.critical = await parseChannels(opts.critical, ctx, tid);
          if (opts.warn !== undefined) routes.warn = await parseChannels(opts.warn, ctx, tid);
          if (opts.info !== undefined) routes.info = await parseChannels(opts.info, ctx, tid);
          const result = await ctx.client.patch<Record<string, unknown>>(
            `/tenants/${tid}/alerts/routing/overrides/${alertCode}`,
            { routes },
          );
          printMutation(program, result, `✓ routing override updated: ${alertCode}`);
        },
      ),
    { args: [{ slot: 0, resource: "alert-codes" }] },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a duration string like "2h", "7d", "30m" into an ISO expiry datetime. */
function resolveMuteExpiry(duration: string): string {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) {
    process.stderr.write(
      `Error: invalid duration "${duration}" — use e.g. 30m, 2h, 7d\n`,
    );
    process.exit(1);
  }
  const n = Number(match[1]);
  const unit = match[2];
  const ms =
    unit === "s" ? n * 1000
    : unit === "m" ? n * 60 * 1000
    : unit === "h" ? n * 60 * 60 * 1000
    : n * 24 * 60 * 60 * 1000; // 'd'
  return new Date(Date.now() + ms).toISOString();
}

/** Fetch a channel by id and return the ChannelRef shape the API expects. */
async function resolveChannelRef(
  ctx: ResolvedContext,
  tid: string,
  channelId: string,
): Promise<{ kind: string; endpoint_id: string }> {
  const ch = await ctx.client.get<{ kind: string }>(
    `/tenants/${tid}/notification-channels/${channelId}`,
  );
  return { kind: ch.kind, endpoint_id: channelId };
}

/** Parse a comma-separated channel spec like "channel:<id>" into ChannelRef objects. */
async function parseChannels(
  spec: string,
  ctx: ResolvedContext,
  tid: string,
): Promise<Array<{ kind: string; endpoint_id: string }>> {
  if (spec === "") return [];
  const out: Array<{ kind: string; endpoint_id: string }> = [];
  for (const ch of spec.split(",")) {
    const trimmed = ch.trim();
    if (!trimmed.startsWith("channel:")) {
      throw new Error(`Invalid channel ref: "${trimmed}" — expected format: channel:<id>`);
    }
    out.push(await resolveChannelRef(ctx, tid, trimmed.slice("channel:".length)));
  }
  return out;
}

// Export the alert codes list for use in completion registry
export { ALERT_CODES };
