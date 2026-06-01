// src/commands/containers.ts
//
// `reoclo containers` — fleet + per-server container operations.
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { requireCapability, withCompletion } from "../client/command-meta";
import { resolveServer } from "../client/resolve";
import { maskInspectResponse } from "../lib/mask-secrets";
import { globalOutput, printList, printMutation, printObject, resolveFormat } from "../ui/output";

const CONTAINER_STATES = ["created", "restarting", "running", "paused", "exited", "dead"];

interface ContainerEntry {
  server_id: string;
  server_hostname: string | null;
  name: string;
  image: string;
  status: string;
  kind: string;
  application_slug: string | null;
}

interface FleetResponse {
  containers: ContainerEntry[];
  next_cursor: string | null;
  stale_servers: unknown[];
}

/** Accumulate a repeatable `KEY=VALUE` flag into a dict. */
function collectKV(value: string, prev: Record<string, string>): Record<string, string> {
  const eq = value.indexOf("=");
  if (eq < 0) throw new Error(`expected KEY=VALUE, got '${value}'`);
  return { ...prev, [value.slice(0, eq)]: value.slice(eq + 1) };
}

/** Accumulate a repeatable string flag into an array. */
function collectArr(value: string, prev: string[]): string[] {
  return [...prev, value];
}

/**
 * Client-side case-insensitive substring filter on container name. Returns the
 * input unchanged when `substr` is empty/undefined so `--name` is opt-in.
 */
export function filterByName<T extends { name: string }>(
  entries: readonly T[],
  substr: string | undefined,
): T[] {
  const needle = substr?.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter((e) => e.name.toLowerCase().includes(needle));
}

/** Parse `host:container[/proto]` into a port spec object. */
function parsePort(spec: string): { host: number; container: number; protocol: string } {
  const slash = spec.split("/");
  const protocol = slash[1] || "tcp";
  const parts = (slash[0] ?? "").split(":");
  const host = Number(parts[0]);
  const container = Number(parts[1]);
  if (parts.length !== 2 || !Number.isInteger(host) || !Number.isInteger(container)) {
    throw new Error(`invalid --port '${spec}' (expected host:container[/proto])`);
  }
  return { host, container, protocol };
}

export function registerContainers(program: Command): void {
  const g = program
    .command("containers")
    .description("manage containers")
    .addHelpText(
      "after",
      `
Examples:
  $ reoclo containers ls
  $ reoclo containers ls --server my-server
  $ reoclo containers ls --server my-server --status running
  $ reoclo containers ls --name api          # substring filter on the fleet
  $ reoclo containers inspect my-server my-app
  $ reoclo containers logs my-server my-app --tail 100
  $ reoclo containers logs my-server my-app --since 1h --search error -f
  $ reoclo containers restart my-server my-app
  $ reoclo containers scale my-server my-app 3
  $ reoclo containers recreate my-server my-app --env DEBUG=1
`,
    );

  const lsCmd = g
    .command("ls")
    .description("list fleet containers")
    .option("--server <idOrSlug>", "filter by server")
    .option("--app <idOrSlug>", "filter by application slug or id")
    .option("--status <status>", "filter by container status")
    .option("--name <substr>", "filter by container name substring (case-insensitive)")
    .action(async (opts: { server?: string; app?: string; status?: string; name?: string }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const serverId = opts.server
        ? await resolveServer(ctx.client, tid, opts.server)
        : undefined;
      const all: ContainerEntry[] = [];
      let staleCount = 0;
      let cursor: string | undefined;
      do {
        const params = new URLSearchParams();
        if (serverId) params.set("server_id", serverId);
        if (opts.app) params.set("application_id", opts.app);
        if (opts.status) params.set("status", opts.status);
        if (cursor) params.set("cursor", cursor);
        const qs = params.toString();
        const res = await ctx.client.get<FleetResponse>(
          `/tenants/${tid}/runtime/containers${qs ? `?${qs}` : ""}`,
        );
        all.push(...(res.containers ?? []));
        staleCount += res.stale_servers?.length ?? 0;
        cursor = res.next_cursor ?? undefined;
      } while (cursor);
      // --name is a client-side substring filter so it works without a
      // dedicated server-side query param and never scrolls the whole fleet.
      const rows = filterByName(all, opts.name);
      printList(
        rows as unknown as Array<Record<string, unknown>>,
        [
          { key: "server_hostname", label: "SERVER" },
          { key: "name", label: "NAME" },
          { key: "image", label: "IMAGE" },
          { key: "status", label: "STATUS" },
          { key: "kind", label: "KIND" },
          { key: "application_slug", label: "APP" },
        ],
        fmt,
      );
      if (staleCount > 0 && fmt === "text") {
        process.stderr.write(`note: ${staleCount} server(s) had stale snapshots\n`);
      }
    });
  withCompletion(lsCmd, {
    flags: {
      "--server": "servers",
      "--app": "apps",
      "--status": { enum: CONTAINER_STATES },
    },
  });
  requireCapability(lsCmd, "container:read");

  // refresh is gated on container:read — it refreshes the snapshot read-cache, not containers.
  requireCapability(
    g
      .command("refresh")
      .description("trigger a fleet container snapshot refresh")
      .action(async () => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const res = await ctx.client.post<Record<string, unknown>>(
          `/tenants/${tid}/runtime/refresh`,
        );
        printMutation(program, res, "✓ snapshot refresh triggered");
      }),
    "container:read",
  );

  const recreateCmd = g
    .command("recreate <server> <name>")
    .description("recreate a container with new env/labels/ports")
    .addHelpText(
      "after",
      `
Examples:
  $ reoclo containers recreate my-server my-app --env DEBUG=1
  $ reoclo containers recreate my-server my-app --label version=2 --label tier=prod
  $ reoclo containers recreate my-server my-app --port 8080:80 --port 443:443/tcp
  $ reoclo containers recreate my-server my-app --remove-label old-key
  $ reoclo containers recreate my-server my-app --persist  # write env/labels back to app record
`,
    )
    .option("--env <kv>", "env var KEY=VALUE — full replacement (repeatable)", collectKV, {})
    .option("--label <kv>", "label KEY=VALUE (repeatable)", collectKV, {})
    .option("--remove-label <key>", "label key to delete (repeatable)", collectArr, [])
    .option("--port <spec>", "port host:container[/proto] (repeatable)", collectArr, [])
    .option("--persist", "also write env/labels back to the app record")
    .option("--replicas <n>", "replica count (Swarm services)")
    .action(
      async (
        server: string,
        name: string,
        opts: {
          env: Record<string, string>;
          label: Record<string, string>;
          removeLabel: string[];
          port: string[];
          persist?: boolean;
          replicas?: string;
        },
      ) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const sid = await resolveServer(ctx.client, tid, server);
        const body: Record<string, unknown> = {};
        if (Object.keys(opts.env).length > 0) body.env = opts.env;
        const labels: Record<string, string | null> = { ...opts.label };
        for (const k of opts.removeLabel) labels[k] = null;
        if (Object.keys(labels).length > 0) body.labels = labels;
        if (opts.port.length > 0) body.ports = opts.port.map(parsePort);
        if (opts.persist) body.persist = true;
        if (opts.replicas !== undefined) body.replicas = Number(opts.replicas);
        const res = await ctx.client.post<{ warnings?: string[] } & Record<string, unknown>>(
          `/tenants/${tid}/runtime/servers/${sid}/containers/${name}/recreate`,
          body,
        );
        printMutation(program, res, `✓ container recreated: ${name}`);
        for (const w of res.warnings ?? []) {
          process.stdout.write(`  warning: ${w}\n`);
        }
      },
    );
  withCompletion(recreateCmd, { args: [{ slot: 0, resource: "servers" }] });
  requireCapability(recreateCmd, "container:write");

  const scaleCmd = g
    .command("scale <server> <name> <replicas>")
    .description("scale a Swarm service to N replicas")
    .action(async (server: string, name: string, replicas: string) => {
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const sid = await resolveServer(ctx.client, tid, server);
      const res = await ctx.client.post<Record<string, unknown>>(
        `/tenants/${tid}/runtime/servers/${sid}/containers/${name}/scale`,
        { replicas: Number(replicas) },
      );
      printMutation(program, res, `✓ scaled ${name} to ${replicas}`);
    });
  withCompletion(scaleCmd, { args: [{ slot: 0, resource: "servers" }] });
  requireCapability(scaleCmd, "container:write");

  const labelsCmd = g
    .command("labels <server> <name>")
    .description("patch a container's labels")
    .option("--label <kv>", "label KEY=VALUE (repeatable)", collectKV, {})
    .option("--remove-label <key>", "label key to delete (repeatable)", collectArr, [])
    .action(
      async (
        server: string,
        name: string,
        opts: { label: Record<string, string>; removeLabel: string[] },
      ) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const sid = await resolveServer(ctx.client, tid, server);
        const labels: Record<string, string | null> = { ...opts.label };
        for (const k of opts.removeLabel) labels[k] = null;
        const res = await ctx.client.patch<Record<string, unknown>>(
          `/tenants/${tid}/runtime/servers/${sid}/containers/${name}/labels`,
          { labels },
        );
        printMutation(program, res, `✓ labels updated: ${name}`);
      },
    );
  withCompletion(labelsCmd, { args: [{ slot: 0, resource: "servers" }] });
  requireCapability(labelsCmd, "container:write");

  const inspectCmd = g
    .command("inspect <server> <name>")
    .description("inspect a container on a server (env values masked by default)")
    .option("--show-secrets", "reveal env var values (masked with *** by default)")
    .addHelpText(
      "after",
      `
Env var VALUES are masked with '***' by default — a running container often
holds live production secrets (DB URIs, cloud keys, API tokens). Keys stay
visible. Pass --show-secrets to reveal the values.
`,
    )
    .action(async (server: string, name: string, opts: { showSecrets?: boolean }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const sid = await resolveServer(ctx.client, tid, server);
      const res = await ctx.client.get<{ env_vars?: Array<{ key: string; value: string }> }>(
        `/tenants/${tid}/servers/${sid}/containers/${name}/inspect`,
      );
      const { response, hiddenCount } = maskInspectResponse(res, opts.showSecrets === true);
      printObject(response, fmt);
      if (hiddenCount > 0 && fmt === "text") {
        process.stderr.write(
          `note: ${hiddenCount} env value(s) hidden — pass --show-secrets to reveal\n`,
        );
      }
    });
  withCompletion(inspectCmd, { args: [{ slot: 0, resource: "servers" }] });
  requireCapability(inspectCmd, "container:read");

  const logsCmd = g
    .command("logs <server> <name>")
    .description("fetch (or follow) a container's logs")
    .option("--tail <n>", "number of log lines (default 200)")
    .option("--since <duration>", "only lines newer than e.g. 1h, 30m (streaming source)")
    .option("--search <pattern>", "regex to filter messages (streaming source)")
    .option("-f, --follow", "stream new log lines, polling every 2s (streaming source)")
    .addHelpText(
      "after",
      `
By default logs are read straight from the container's stdout/stderr (--tail).
Passing --since, --search, or --follow switches to the runner's streaming
source (the same one 'reoclo logs tail' uses), which supports time ranges,
regex filtering, and live follow.
`,
    )
    .action(
      async (
        server: string,
        name: string,
        opts: { tail?: string; since?: string; search?: string; follow?: boolean },
      ) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const sid = await resolveServer(ctx.client, tid, server);

        const useStream =
          opts.since !== undefined || opts.search !== undefined || opts.follow === true;

        // Simple path: docker stdout/stderr via the per-container logs endpoint.
        if (!useStream) {
          const qs = opts.tail ? `?tail=${encodeURIComponent(opts.tail)}` : "";
          const res = await ctx.client.get<
            { stdout: string; stderr: string } & Record<string, unknown>
          >(`/tenants/${tid}/servers/${sid}/containers/${name}/logs${qs}`);
          if (fmt === "json" || fmt === "yaml") {
            printObject(res, fmt);
            return;
          }
          if (res.stdout)
            process.stdout.write(res.stdout.endsWith("\n") ? res.stdout : `${res.stdout}\n`);
          if (res.stderr)
            process.stderr.write(res.stderr.endsWith("\n") ? res.stderr : `${res.stderr}\n`);
          return;
        }

        // Streaming path: runner live-logs source (supports since/search/follow).
        interface LiveLogEntry {
          ts: string;
          level: string;
          message: string;
          [k: string]: unknown;
        }
        interface LiveLogResponse {
          entries: LiveLogEntry[];
          [k: string]: unknown;
        }
        const liveQs = (since: string, tail: string): string => {
          const p = new URLSearchParams({
            server_id: sid,
            source_type: "container",
            source_name: name,
            since,
            tail,
          });
          if (opts.search) p.set("search", opts.search);
          return p.toString();
        };
        const printEntries = (entries: LiveLogEntry[]): void => {
          for (const e of entries) process.stdout.write(`${e.ts} [${e.level}] ${e.message}\n`);
        };

        const initial = await ctx.client.get<LiveLogResponse>(
          `/tenants/${tid}/logs/live?${liveQs(opts.since ?? "5m", opts.tail ?? "200")}`,
        );

        if (!opts.follow && (fmt === "json" || fmt === "yaml")) {
          printObject(initial, fmt);
          return;
        }
        printEntries(initial.entries);
        if (!opts.follow) return;

        // Follow: poll every 2s, deduping on the most recent ts seen.
        let lastTs = initial.entries.at(-1)?.ts ?? new Date().toISOString();
        let stopped = false;
        process.once("SIGINT", () => {
          stopped = true;
        });
        while (!stopped) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          if (stopped) break;
          const res = await ctx.client.get<LiveLogResponse>(
            `/tenants/${tid}/logs/live?${liveQs(lastTs, "200")}`,
          );
          const fresh = res.entries.filter((e) => e.ts > lastTs);
          if (fresh.length > 0) {
            printEntries(fresh);
            lastTs = fresh.at(-1)!.ts;
          }
        }
      },
    );
  withCompletion(logsCmd, { args: [{ slot: 0, resource: "servers" }] });
  requireCapability(logsCmd, "container:logs:tail");

  const restartCmd = g
    .command("restart <server> <name>")
    .description("restart a container on a server")
    .action(async (server: string, name: string) => {
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const sid = await resolveServer(ctx.client, tid, server);
      const res = await ctx.client.post<Record<string, unknown>>(
        `/tenants/${tid}/servers/${sid}/containers/${name}/restart`,
      );
      printMutation(program, res, `✓ container restarted: ${name}`);
    });
  withCompletion(restartCmd, { args: [{ slot: 0, resource: "servers" }] });
  requireCapability(restartCmd, "container:write");
}
