// src/commands/proxy.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveServer } from "../client/resolve";
import { withCompletion } from "../client/command-meta";
import { printMutation } from "../ui/output";

export function registerProxy(program: Command): void {
  const g = program.command("proxy").description("manage a server's managed proxy");

  withCompletion(
    g
      .command("reconcile <server>")
      .description("re-sync the managed proxy now instead of waiting for the next reconcile tick")
      .action(async (serverRef: string) => {
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const sid = await resolveServer(ctx.client, tid, serverRef);
        const res = await ctx.client.post<Record<string, unknown>>(
          `/tenants/${tid}/servers/${sid}/proxy/reconcile-now`,
        );
        printMutation(program, res ?? {}, `\u2713 proxy reconcile triggered for ${serverRef}`);
      }),
    { args: [{ slot: 0, resource: "servers" }] },
  );
}
