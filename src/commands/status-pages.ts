// src/commands/status-pages.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { withCompletion } from "../client/command-meta";
import { cacheList } from "../completion/populate";
import { globalOutput, printList, printMutation, printObject, resolveFormat } from "../ui/output";

interface StatusPage {
  id: string;
  title: string;
  slug: string;
  is_published: boolean;
}

export function registerStatusPages(program: Command): void {
  const g = program.command("status-pages").description("manage status pages");

  // Collection routes (ls, create) use a trailing slash; item routes (get/update/rm) do not — matches the API's status-pages routing.
  g.command("ls")
    .description("list status pages")
    .action(async () => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const list = await ctx.client.get<StatusPage[]>(`/tenants/${tid}/status-pages/`);
      cacheList("status-pages", list);
      printList(
        list as unknown as Array<Record<string, unknown>>,
        [
          { key: "id", label: "ID" },
          { key: "title", label: "TITLE" },
          { key: "slug", label: "SLUG" },
          { key: "is_published", label: "PUBLISHED" },
        ],
        fmt,
      );
    });

  withCompletion(
    g
      .command("get <id>")
      .description("show one status page")
      .action(async (id: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const sp = await ctx.client.get<Record<string, unknown>>(
          `/tenants/${tid}/status-pages/${id}`,
        );
        printObject(sp, fmt);
      }),
    { args: [{ slot: 0, resource: "status-pages" }] },
  );

  g.command("create")
    .description("create a status page")
    .option("--title <title>", "page title")
    .option("--label <label>", "short label")
    .option("--description <text>", "page description")
    .action(async (opts: { title?: string; label?: string; description?: string }) => {
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const body: Record<string, unknown> = {};
      if (opts.title !== undefined) body.title = opts.title;
      if (opts.label !== undefined) body.label = opts.label;
      if (opts.description !== undefined) body.description = opts.description;
      const sp = await ctx.client.post<StatusPage>(`/tenants/${tid}/status-pages/`, body);
      printMutation(program, sp as unknown as Record<string, unknown>, `✓ status page created: ${sp.id}`);
    });

  withCompletion(
    g
      .command("update <id>")
      .description("update a status page")
      .option("--title <title>", "page title")
      .option("--label <label>", "short label")
      .option("--description <text>", "page description")
      .option("--published <bool>", "publish state (true|false)")
      .action(
        async (
          id: string,
          opts: { title?: string; label?: string; description?: string; published?: string },
        ) => {
          const ctx = await bootstrap();
          const tid = requireTenantId(ctx);
          const body: Record<string, unknown> = {};
          if (opts.title !== undefined) body.title = opts.title;
          if (opts.label !== undefined) body.label = opts.label;
          if (opts.description !== undefined) body.description = opts.description;
          if (opts.published !== undefined) {
            if (opts.published !== "true" && opts.published !== "false") {
              process.stderr.write(
                `error: --published must be 'true' or 'false', got '${opts.published}'\n`,
              );
              process.exit(1);
            }
            body.is_published = opts.published === "true";
          }
          const sp = await ctx.client.patch<StatusPage>(
            `/tenants/${tid}/status-pages/${id}`,
            body,
          );
          printMutation(program, sp as unknown as Record<string, unknown>, `✓ status page updated: ${sp.id}`);
        },
      ),
    { args: [{ slot: 0, resource: "status-pages" }] },
  );

  withCompletion(
    g
      .command("rm <id>")
      .description("delete a status page")
      .action(async (id: string) => {
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        await ctx.client.del<void>(`/tenants/${tid}/status-pages/${id}`);
        process.stdout.write(`✓ status page removed: ${id}\n`);
      }),
    { args: [{ slot: 0, resource: "status-pages" }] },
  );
}
