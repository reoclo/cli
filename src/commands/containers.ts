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

export function registerContainers(program: Command): void {
  const g = program.command("containers").description("manage containers");

  withCompletion(
    requireCapability(
      g
        .command("ls")
        .description("list fleet containers")
        .option("--server <idOrSlug>", "filter by server")
        .option("--app <idOrSlug>", "filter by application id")
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
            staleCount = res.stale_servers?.length ?? 0;
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
        }),
      "container:read",
    ),
    {
      flags: {
        "--server": "servers",
        "--app": "apps",
        "--status": { enum: CONTAINER_STATES },
      },
    },
  );

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
}
