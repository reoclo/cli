// src/commands/repos.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { withCompletion } from "../client/command-meta";
import { resolveRepo } from "../client/resolve";
import type { PaginatedResponse, Repository } from "../client/types";
import { cacheList } from "../completion/populate";
import { globalOutput, printList, printObject, resolveFormat } from "../ui/output";

interface Branch {
  name: string;
  is_default: boolean;
}

export function registerRepos(program: Command): void {
  const g = program.command("repos").description("manage mirrored git repositories");

  g.command("ls")
    .description("list repositories")
    .option("--search <q>", "filter by repo name or full_name")
    .action(async (opts: { search?: string }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = requireTenantId(ctx);
      const all: Repository[] = [];
      let skip = 0;
      const limit = 200;
      while (true) {
        const q = new URLSearchParams({ skip: String(skip), limit: String(limit) });
        if (opts.search) q.set("search", opts.search);
        const page = await ctx.client.get<PaginatedResponse<Repository>>(
          `/tenants/${tid}/repositories/?${q.toString()}`,
        );
        all.push(...page.items);
        if (page.items.length < limit) break;
        skip += limit;
      }
      cacheList("repos", all);
      printList(
        all as unknown as Array<Record<string, unknown>>,
        [
          { key: "full_name", label: "NAME" },
          { key: "default_branch", label: "DEFAULT" },
          { key: "is_private", label: "PRIVATE" },
          { key: "last_push_at", label: "LAST PUSH" },
          { key: "status", label: "STATUS" },
        ],
        fmt,
      );
    });

  withCompletion(
    g
      .command("get <repo>")
      .description("show one repository (accepts slug or id)")
      .action(async (repo: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const id = await resolveRepo(ctx.client, tid, repo);
        const r = await ctx.client.get<Record<string, unknown>>(
          `/tenants/${tid}/repositories/${id}`,
        );
        printObject(r, fmt);
      }),
    { args: [{ slot: 0, resource: "repos" }] },
  );

  withCompletion(
    g
      .command("branches <repo>")
      .description("list branches for a repository")
      .action(async (repo: string) => {
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = requireTenantId(ctx);
        const id = await resolveRepo(ctx.client, tid, repo);
        const branches = await ctx.client.get<Branch[]>(
          `/tenants/${tid}/repositories/${id}/branches`,
        );
        const rows = branches.map((b) => ({
          BRANCH: b.name,
          DEFAULT: b.is_default ? "✓" : "",
        }));
        printList(
          rows as unknown as Array<Record<string, unknown>>,
          [
            { key: "BRANCH", label: "BRANCH" },
            { key: "DEFAULT", label: "DEFAULT" },
          ],
          fmt,
        );
      }),
    { args: [{ slot: 0, resource: "repos" }] },
  );
}
