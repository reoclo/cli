// src/commands/apps.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveApp } from "../client/resolve";
import { printList, printObject, resolveFormat } from "../ui/output";
import type { Application } from "../client/types";

function globalOutput(program: Command): string | undefined {
  const opts: Record<string, unknown> = program.opts();
  return typeof opts["output"] === "string" ? opts["output"] : undefined;
}

export function registerApps(program: Command): void {
  const g = program.command("apps").description("manage applications");

  g.command("ls")
    .description("list applications in the tenant")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const list = await ctx.client.get<Application[]>(`/tenants/${tid}/applications/`);
      printList(
        list as unknown as Array<Record<string, unknown>>,
        [
          { key: "slug", label: "SLUG" },
          { key: "name", label: "NAME" },
          { key: "server_id", label: "SERVER" },
          { key: "current_deployment_id", label: "DEPLOYMENT" },
        ],
        fmt,
      );
    });

  g.command("get <idOrSlug>")
    .description("show details for one application")
    .action(async (idOrSlug: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const id = await resolveApp(ctx.client, tid, idOrSlug);
      const app = await ctx.client.get<Application>(`/tenants/${tid}/applications/${id}`);
      printObject(app as unknown as Record<string, unknown>, fmt);
    });
}
