// src/commands/channels.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { withCompletion } from "../client/command-meta";
import { cacheList } from "../completion/populate";
import { globalOutput, printList, printMutation, printObject, resolveFormat } from "../ui/output";

interface NotificationChannel {
  id: string;
  kind: string;
  name: string;
  enabled: boolean;
  events: Record<string, boolean>;
  created_at: string;
  updated_at: string;
}

interface ChannelKindMeta {
  kind: string;
  label: string;
  secret_required: boolean;
  secret_field: string | null;
  docs_url: string;
}

export function registerChannels(program: Command): void {
  const g = program.command("channels").description("manage notification channels");

  // ---------------------------------------------------------------------------
  // list
  // ---------------------------------------------------------------------------

  g.command("list")
    .description("list notification channels")
    .option("--kind <kind>", "filter by provider kind")
    .option("--enabled <bool>", "filter by enabled status (true|false)")
    .action(
      async (opts: { kind?: string; enabled?: string }) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const params = new URLSearchParams();
        if (opts.kind) params.set("kind", opts.kind);
        if (opts.enabled !== undefined) params.set("enabled", opts.enabled);
        const qs = params.toString() ? `?${params.toString()}` : "";
        const list = await ctx.client.get<NotificationChannel[]>(
          `/tenants/${tid}/notification-channels${qs}`,
        );
        cacheList("channel-ids", list);
        printList(
          list as unknown as Array<Record<string, unknown>>,
          [
            { key: "id", label: "ID" },
            { key: "kind", label: "KIND" },
            { key: "name", label: "NAME" },
            { key: "enabled", label: "ENABLED" },
          ],
          fmt,
        );
      },
    );

  // ---------------------------------------------------------------------------
  // kinds
  // ---------------------------------------------------------------------------

  g.command("kinds")
    .description("list available channel provider kinds")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const list = await ctx.client.get<ChannelKindMeta[]>(
        `/tenants/${tid}/notification-channels/kinds`,
      );
      cacheList("channel-kinds", list);
      printList(
        list as unknown as Array<Record<string, unknown>>,
        [
          { key: "kind", label: "KIND" },
          { key: "label", label: "LABEL" },
          { key: "secret_required", label: "SECRET_REQUIRED" },
          { key: "docs_url", label: "DOCS" },
        ],
        fmt,
      );
    });

  // ---------------------------------------------------------------------------
  // get
  // ---------------------------------------------------------------------------

  withCompletion(
    g
      .command("get <id>")
      .description("show one notification channel")
      .action(async (id: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const channel = await ctx.client.get<Record<string, unknown>>(
          `/tenants/${tid}/notification-channels/${id}`,
        );
        printObject(channel, fmt);
      }),
    { args: [{ slot: 0, resource: "channel-ids" }] },
  );

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------

  withCompletion(
    g
      .command("create <kind>")
      .description("create a notification channel")
      .requiredOption("--name <name>", "display name")
      .option("--config <kv>", "config as key=value,... pairs")
      .option("--secret <secret>", "provider secret (token, webhook URL, password)")
      .option("--from-file <path>", "load full channel spec from YAML file (supports ${env:VAR})")
      .option("--events <csv>", "comma-separated event names to enable")
      .option("--disabled", "create in disabled state")
      .action(
        async (
          kind: string,
          opts: {
            name: string;
            config?: string;
            secret?: string;
            fromFile?: string;
            events?: string;
            disabled?: boolean;
          },
        ) => {
          const ctx = await bootstrap();
          const tid = requireTenantId(ctx);
          let body: Record<string, unknown>;
          if (opts.fromFile) {
            body = (await loadFromFile(opts.fromFile)) as Record<string, unknown>;
          } else {
            body = {
              kind,
              name: opts.name,
              enabled: !opts.disabled,
            };
            if (opts.config) body.config = parseKv(opts.config);
            if (opts.secret !== undefined) body.secret = opts.secret;
            if (opts.events) body.events = parseEvents(opts.events);
          }
          const channel = await ctx.client.post<Record<string, unknown>>(
            `/tenants/${tid}/notification-channels`,
            body,
          );
          printMutation(
            program,
            channel,
            `✓ channel created: ${String(channel.id ?? "")}`,
          );
        },
      ),
    { args: [{ slot: 0, resource: "channel-kinds" }] },
  );

  // ---------------------------------------------------------------------------
  // update
  // ---------------------------------------------------------------------------

  withCompletion(
    g
      .command("update <id>")
      .description("update a notification channel")
      .option("--name <name>", "new display name")
      .option("--config <kv>", "config key=value,... pairs to merge")
      .option("--secret <secret>", "new provider secret")
      .option("--events <csv>", "comma-separated event names to enable")
      .option("--enabled <bool>", "enable or disable (true|false)")
      .action(
        async (
          id: string,
          opts: {
            name?: string;
            config?: string;
            secret?: string;
            events?: string;
            enabled?: string;
          },
        ) => {
          const ctx = await bootstrap();
          const tid = requireTenantId(ctx);
          const body: Record<string, unknown> = {};
          if (opts.name !== undefined) body.name = opts.name;
          if (opts.config !== undefined) body.config = parseKv(opts.config);
          if (opts.secret !== undefined) body.secret = opts.secret;
          if (opts.events !== undefined) body.events = parseEvents(opts.events);
          if (opts.enabled !== undefined) body.enabled = opts.enabled !== "false";
          const channel = await ctx.client.patch<Record<string, unknown>>(
            `/tenants/${tid}/notification-channels/${id}`,
            body,
          );
          printMutation(program, channel, `✓ channel updated: ${id}`);
        },
      ),
    { args: [{ slot: 0, resource: "channel-ids" }] },
  );

  // ---------------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------------

  withCompletion(
    g
      .command("delete <id>")
      .description("delete a notification channel")
      .option("--force", "also strip references from alert routing")
      .action(async (id: string, opts: { force?: boolean }) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const qs = opts.force ? "?force=true" : "";
        await ctx.client.del<void>(`/tenants/${tid}/notification-channels/${id}${qs}`);
        process.stdout.write(`✓ channel deleted: ${id}\n`);
      }),
    { args: [{ slot: 0, resource: "channel-ids" }] },
  );

  // ---------------------------------------------------------------------------
  // test
  // ---------------------------------------------------------------------------

  withCompletion(
    g
      .command("test <id>")
      .description("send a test notification through the channel")
      .option("--to <addr>", "override recipient address (email channels only)")
      .action(async (id: string, opts: { to?: string }) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const body: Record<string, unknown> = {};
        if (opts.to) body.recipient_override = opts.to;
        const result = await ctx.client.post<Record<string, unknown>>(
          `/tenants/${tid}/notification-channels/${id}/test`,
          body,
        );
        printMutation(program, result, `✓ test sent via channel: ${id}`);
      }),
    { args: [{ slot: 0, resource: "channel-ids" }] },
  );

  // ---------------------------------------------------------------------------
  // enable / disable
  // ---------------------------------------------------------------------------

  withCompletion(
    g
      .command("enable <id>")
      .description("enable a notification channel")
      .action(async (id: string) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const channel = await ctx.client.patch<Record<string, unknown>>(
          `/tenants/${tid}/notification-channels/${id}`,
          { enabled: true },
        );
        printMutation(program, channel, `✓ channel enabled: ${id}`);
      }),
    { args: [{ slot: 0, resource: "channel-ids" }] },
  );

  withCompletion(
    g
      .command("disable <id>")
      .description("disable a notification channel")
      .action(async (id: string) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const channel = await ctx.client.patch<Record<string, unknown>>(
          `/tenants/${tid}/notification-channels/${id}`,
          { enabled: false },
        );
        printMutation(program, channel, `✓ channel disabled: ${id}`);
      }),
    { args: [{ slot: 0, resource: "channel-ids" }] },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse "key=value,key2=value2" into an object. */
function parseKv(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of input.split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    out[k] = v;
  }
  return out;
}

/** Parse "event_name,event2" into { event_name: true, event2: true }. */
function parseEvents(input: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const e of input.split(",").map((s) => s.trim()).filter(Boolean)) {
    out[e] = true;
  }
  return out;
}

/** Load a JSON or YAML file and expand ${env:VAR} placeholders. */
async function loadFromFile(filePath: string): Promise<unknown> {
  const fs = await import("node:fs/promises");
  const raw = await fs.readFile(filePath, "utf-8");
  // Expand ${env:VAR} placeholders before parsing
  const expanded = raw.replace(/\$\{env:([A-Z_][A-Z0-9_]*)\}/g, (_, name: string) => {
    const v = process.env[name];
    if (v === undefined) {
      throw new Error(`Environment variable ${name} not set (referenced in ${filePath})`);
    }
    return v;
  });
  if (filePath.endsWith(".json")) {
    return JSON.parse(expanded) as unknown;
  }
  // YAML (default for .yml / .yaml and any other extension)
  const { load } = await import("js-yaml");
  return load(expanded);
}
