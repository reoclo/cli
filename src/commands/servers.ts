// src/commands/servers.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveServer } from "../client/resolve";
import { printList, printObject, resolveFormat } from "../ui/output";
import type { Server } from "../client/types";

function globalOutput(program: Command): string | undefined {
  const opts: Record<string, unknown> = program.opts();
  return typeof opts["output"] === "string" ? opts["output"] : undefined;
}

export function registerServers(program: Command): void {
  const g = program.command("servers").description("manage servers");

  g.command("ls")
    .description("list servers in the tenant")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const list = await ctx.client.get<Server[]>(`/tenants/${tid}/servers/`);
      printList(
        list as unknown as Array<Record<string, unknown>>,
        [
          { key: "name", label: "NAME" },
          { key: "hostname", label: "HOSTNAME" },
          { key: "public_ip", label: "IP" },
          { key: "status", label: "STATUS" },
          { key: "runner_version", label: "RUNNER" },
        ],
        fmt,
      );
    });

  g.command("get <idOrName>")
    .description("show details for one server")
    .action(async (idOrName: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const id = await resolveServer(ctx.client, tid, idOrName);
      const srv = await ctx.client.get<Server>(`/tenants/${tid}/servers/${id}`);
      printObject(srv as unknown as Record<string, unknown>, fmt);
    });

  g.command("metrics <idOrName>")
    .description("show CPU/RAM/disk metrics for a server")
    .action(async (idOrName: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const id = await resolveServer(ctx.client, tid, idOrName);
      const m = await ctx.client.get<Record<string, unknown>>(
        `/tenants/${tid}/servers/${id}/metrics`,
      );
      printObject(m, fmt);
    });
}
