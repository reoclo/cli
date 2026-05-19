// src/commands/servers.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveServer } from "../client/resolve";
import { globalOutput, printList, printObject, resolveFormat } from "../ui/output";
import type { Server } from "../client/types";
import { requireCapability, withCompletion } from "../client/command-meta";
import { cacheList } from "../completion/populate";
import { promptYesNo } from "../ui/prompt";

const SERVER_CONTAINER_STATES = ["created", "restarting", "running", "paused", "exited", "dead"];

export function registerServers(program: Command): void {
  const g = program.command("servers").description("manage servers");

  g.command("ls")
    .description("list servers in the organization")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const list = await ctx.client.get<Server[]>(`/tenants/${tid}/servers/`);
      cacheList("servers", list);
      printList(
        list as unknown as Array<Record<string, unknown>>,
        [
          { key: "slug", label: "SLUG" },
          { key: "name", label: "NAME" },
          { key: "hostname", label: "HOSTNAME" },
          { key: "public_ip", label: "IP" },
          { key: "status", label: "STATUS" },
          { key: "runner_version", label: "RUNNER" },
        ],
        fmt,
      );
    });

  withCompletion(
    g
      .command("get <idOrSlug>")
      .description("show details for one server")
      .action(async (idOrSlug: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const id = await resolveServer(ctx.client, tid, idOrSlug);
        const srv = await ctx.client.get<Server>(`/tenants/${tid}/servers/${id}`);
        printObject(srv as unknown as Record<string, unknown>, fmt);
      }),
    { args: [{ slot: 0, resource: "servers" }] },
  );

  withCompletion(
    g
      .command("metrics <idOrSlug>")
      .description("show CPU/RAM/disk metrics for a server")
      .action(async (idOrSlug: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const id = await resolveServer(ctx.client, tid, idOrSlug);
        const m = await ctx.client.get<Record<string, unknown>>(
          `/tenants/${tid}/servers/${id}/metrics`,
        );
        printObject(m, fmt);
      }),
    { args: [{ slot: 0, resource: "servers" }] },
  );

  withCompletion(
    g
      .command("set-slug <idOrSlug> <newSlug>")
      .description("change a server's slug (URL- and CLI-safe identifier)")
      .action(async (idOrSlug: string, newSlug: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const id = await resolveServer(ctx.client, tid, idOrSlug);

        const before = await ctx.client.get<Server>(`/tenants/${tid}/servers/${id}`);
        const updated = await ctx.client.patch<Server>(`/tenants/${tid}/servers/${id}`, {
          slug: newSlug,
        });

        if (fmt === "json") {
          printObject(updated as unknown as Record<string, unknown>, fmt);
          return;
        }
        process.stdout.write(`✓ slug updated: ${before.slug} → ${updated.slug}\n`);
      }),
    { args: [{ slot: 0, resource: "servers" }] },
  );

  const serversContainersCmd = g
    .command("containers <idOrSlug>")
    .description("list containers running on a server")
    .option("--status <status>", "filter by container status")
    .action(async (idOrSlug: string, opts: { status?: string }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const sid = await resolveServer(ctx.client, tid, idOrSlug);
      const qs = opts.status ? `?status=${encodeURIComponent(opts.status)}` : "";
      const res = await ctx.client.get<{ containers: Array<Record<string, unknown>> }>(
        `/tenants/${tid}/servers/${sid}/containers${qs}`,
      );
      printList(
        res.containers,
        [
          { key: "name", label: "NAME" },
          { key: "image", label: "IMAGE" },
          { key: "status", label: "STATUS" },
          { key: "state", label: "STATE" },
        ],
        fmt,
      );
    });
  withCompletion(serversContainersCmd, {
    args: [{ slot: 0, resource: "servers" }],
    flags: { "--status": { enum: SERVER_CONTAINER_STATES } },
  });
  requireCapability(serversContainersCmd, "container:read");

  withCompletion(
    g
      .command("health <idOrSlug>")
      .description("show a server's health state")
      .action(async (idOrSlug: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const sid = await resolveServer(ctx.client, tid, idOrSlug);
        const res = await ctx.client.get<Record<string, unknown>>(
          `/tenants/${tid}/servers/${sid}/health`,
        );
        printObject(res, fmt);
      }),
    { args: [{ slot: 0, resource: "servers" }] },
  );

  withCompletion(
    g
      .command("ports <idOrSlug>")
      .description("scan a server's listening ports and firewall")
      .action(async (idOrSlug: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const sid = await resolveServer(ctx.client, tid, idOrSlug);
        const res = await ctx.client.get<
          {
            listening_ports: Array<Record<string, unknown>>;
            firewall: { detected?: boolean; active?: boolean; backend?: string | null };
          } & Record<string, unknown>
        >(`/tenants/${tid}/servers/${sid}/ports`);
        if (fmt === "json" || fmt === "yaml") {
          printObject(res, fmt);
          return;
        }
        printList(
          res.listening_ports,
          [
            { key: "port", label: "PORT" },
            { key: "protocol", label: "PROTO" },
            { key: "address", label: "ADDRESS" },
            { key: "process", label: "PROCESS" },
          ],
          fmt,
        );
        const fw = res.firewall;
        process.stdout.write(
          `\nfirewall: detected=${fw.detected ?? false} active=${fw.active ?? false} backend=${fw.backend ?? "-"}\n`,
        );
      }),
    { args: [{ slot: 0, resource: "servers" }] },
  );

  withCompletion(
    g
      .command("uptime <idOrSlug>")
      .description("show a server's connectivity uptime")
      .option("--hours <n>", "lookback window in hours (1-168, default 6)")
      .action(async (idOrSlug: string, opts: { hours?: string }) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const sid = await resolveServer(ctx.client, tid, idOrSlug);
        const qs = opts.hours ? `?hours=${encodeURIComponent(opts.hours)}` : "";
        const res = await ctx.client.get<
          {
            buckets: Array<Record<string, unknown>>;
            overall_uptime_pct: number;
          } & Record<string, unknown>
        >(`/tenants/${tid}/servers/${sid}/uptime${qs}`);
        if (fmt === "json" || fmt === "yaml") {
          printObject(res, fmt);
          return;
        }
        printList(
          res.buckets,
          [
            { key: "slot_start", label: "SLOT START" },
            { key: "status", label: "STATUS" },
            { key: "uptime_pct", label: "UPTIME %" },
          ],
          fmt,
        );
        process.stdout.write(`\noverall uptime: ${res.overall_uptime_pct}%\n`);
      }),
    { args: [{ slot: 0, resource: "servers" }] },
  );

  withCompletion(
    g
      .command("reboot <idOrSlug>")
      .description("reboot a server")
      .option("--yes", "skip the confirmation prompt")
      .action(async (idOrSlug: string, opts: { yes?: boolean }) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const sid = await resolveServer(ctx.client, tid, idOrSlug);
        if (!opts.yes) {
          const ok = await promptYesNo(`Reboot server '${idOrSlug}'? [y/N] `);
          if (!ok) {
            process.stderr.write("aborted (pass --yes to skip this prompt)\n");
            const err = new Error("reboot aborted") as Error & { exitCode: number };
            err.exitCode = 1;
            throw err;
          }
        }
        const res = await ctx.client.post<{ message?: string } & Record<string, unknown>>(
          `/tenants/${tid}/servers/${sid}/reboot`,
        );
        if (fmt === "json" || fmt === "yaml") {
          printObject(res, fmt);
          return;
        }
        process.stdout.write(`✓ reboot signaled: ${idOrSlug}\n`);
        if (res.message) process.stdout.write(`  ${res.message}\n`);
      }),
    { args: [{ slot: 0, resource: "servers" }] },
  );
}
