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
    .action(async (opts: { name: string; url: string; interval?: string }) => {
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const body: Record<string, unknown> = { name: opts.name, url: opts.url };
      if (opts.interval !== undefined) body.check_interval_seconds = Number(opts.interval);
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
      .action(
        async (id: string, opts: { name?: string; url?: string; interval?: string }) => {
          const ctx = await bootstrap();
          const tid = requireTenantId(ctx);
          const body: Record<string, unknown> = {};
          if (opts.name !== undefined) body.name = opts.name;
          if (opts.url !== undefined) body.url = opts.url;
          if (opts.interval !== undefined) body.check_interval_seconds = Number(opts.interval);
          const m = await ctx.client.patch<Monitor>(`/tenants/${tid}/monitors/${id}`, body);
          printMutation(program, m as unknown as Record<string, unknown>, `✓ monitor updated: ${m.id}`);
        },
      ),
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
