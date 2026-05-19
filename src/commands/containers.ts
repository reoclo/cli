// src/commands/containers.ts
//
// `reoclo containers` — fleet + per-server container operations.
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { requireCapability, withCompletion } from "../client/command-meta";
import { resolveServer } from "../client/resolve";
import { globalOutput, printList, printObject, resolveFormat } from "../ui/output";

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

/** Parse `host:container[/proto]` into a port spec object. */
function parsePort(spec: string): { host: number; container: number; protocol: string } {
  const slash = spec.split("/");
  const protocol = slash[1] ?? "tcp";
  const parts = (slash[0] ?? "").split(":");
  const host = Number(parts[0]);
  const container = Number(parts[1]);
  if (parts.length !== 2 || !Number.isInteger(host) || !Number.isInteger(container)) {
    throw new Error(`invalid --port '${spec}' (expected host:container[/proto])`);
  }
  return { host, container, protocol };
}

export function registerContainers(program: Command): void {
  const g = program.command("containers").description("manage containers");

  const lsCmd = g
    .command("ls")
    .description("list fleet containers")
    .option("--server <idOrSlug>", "filter by server")
    .option("--app <idOrSlug>", "filter by application slug or id")
    .option("--status <status>", "filter by container status")
    .action(async (opts: { server?: string; app?: string; status?: string }) => {
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
        all.push(...res.containers);
        staleCount += res.stale_servers?.length ?? 0;
        cursor = res.next_cursor ?? undefined;
      } while (cursor);
      printList(
        all as unknown as Array<Record<string, unknown>>,
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
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const res = await ctx.client.post<Record<string, unknown>>(
          `/tenants/${tid}/runtime/refresh`,
        );
        if (fmt === "json" || fmt === "yaml") {
          printObject(res, fmt);
          return;
        }
        process.stdout.write("✓ snapshot refresh triggered\n");
      }),
    "container:read",
  );

  const recreateCmd = g
    .command("recreate <server> <name>")
    .description("recreate a container with new env/labels/ports")
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
        const fmt = resolveFormat(globalOutput(program));
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
        if (fmt === "json" || fmt === "yaml") {
          printObject(res, fmt);
          return;
        }
        process.stdout.write(`✓ container recreated: ${name}\n`);
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
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const sid = await resolveServer(ctx.client, tid, server);
      const res = await ctx.client.post<Record<string, unknown>>(
        `/tenants/${tid}/runtime/servers/${sid}/containers/${name}/scale`,
        { replicas: Number(replicas) },
      );
      if (fmt === "json" || fmt === "yaml") {
        printObject(res, fmt);
        return;
      }
      process.stdout.write(`✓ scaled ${name} to ${replicas}\n`);
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
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const sid = await resolveServer(ctx.client, tid, server);
        const labels: Record<string, string | null> = { ...opts.label };
        for (const k of opts.removeLabel) labels[k] = null;
        const res = await ctx.client.patch<Record<string, unknown>>(
          `/tenants/${tid}/runtime/servers/${sid}/containers/${name}/labels`,
          { labels },
        );
        if (fmt === "json" || fmt === "yaml") {
          printObject(res, fmt);
          return;
        }
        process.stdout.write(`✓ labels updated: ${name}\n`);
      },
    );
  withCompletion(labelsCmd, { args: [{ slot: 0, resource: "servers" }] });
  requireCapability(labelsCmd, "container:write");

  const inspectCmd = g
    .command("inspect <server> <name>")
    .description("inspect a container on a server")
    .action(async (server: string, name: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const sid = await resolveServer(ctx.client, tid, server);
      const res = await ctx.client.get<Record<string, unknown>>(
        `/tenants/${tid}/servers/${sid}/containers/${name}/inspect`,
      );
      printObject(res, fmt);
    });
  withCompletion(inspectCmd, { args: [{ slot: 0, resource: "servers" }] });
  requireCapability(inspectCmd, "container:read");

  const logsCmd = g
    .command("logs <server> <name>")
    .description("fetch a container's logs")
    .option("--tail <n>", "number of log lines (default 200)")
    .action(async (server: string, name: string, opts: { tail?: string }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const sid = await resolveServer(ctx.client, tid, server);
      const qs = opts.tail ? `?tail=${encodeURIComponent(opts.tail)}` : "";
      const res = await ctx.client.get<{ stdout: string; stderr: string } & Record<string, unknown>>(
        `/tenants/${tid}/servers/${sid}/containers/${name}/logs${qs}`,
      );
      if (fmt === "json" || fmt === "yaml") {
        printObject(res, fmt);
        return;
      }
      if (res.stdout) process.stdout.write(res.stdout.endsWith("\n") ? res.stdout : `${res.stdout}\n`);
      if (res.stderr) process.stderr.write(res.stderr.endsWith("\n") ? res.stderr : `${res.stderr}\n`);
    });
  withCompletion(logsCmd, { args: [{ slot: 0, resource: "servers" }] });
  requireCapability(logsCmd, "container:logs:tail");

  const restartCmd = g
    .command("restart <server> <name>")
    .description("restart a container on a server")
    .action(async (server: string, name: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const sid = await resolveServer(ctx.client, tid, server);
      const res = await ctx.client.post<Record<string, unknown>>(
        `/tenants/${tid}/servers/${sid}/containers/${name}/restart`,
      );
      if (fmt === "json" || fmt === "yaml") {
        printObject(res, fmt);
        return;
      }
      process.stdout.write(`✓ container restarted: ${name}\n`);
    });
  withCompletion(restartCmd, { args: [{ slot: 0, resource: "servers" }] });
  requireCapability(restartCmd, "container:write");
}
