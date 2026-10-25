// src/commands/build-pools.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { withCompletion } from "../client/command-meta";
import { EXIT } from "../client/exit-codes";
import type { HttpClient } from "../client/http";
import { isUuid, resolveServer } from "../client/resolve";
import type { PaginatedResponse } from "../client/types";
import { globalOutput, printList, printMutation, printObject, resolveFormat } from "../ui/output";
import { promptYesNo } from "../ui/prompt";
import { badUsage, parseIntFlag } from "../util/parse-flag";
import { parseLimit, parseOffset } from "../util/parse-limit";

const HARD_LIMIT = 100;
const MAX_CONCURRENT_RANGE = { min: 1, max: 16 } as const;

interface BuildPool {
  id: string;
  name: string;
  mode: string;
  server_ids: string[];
  max_concurrent_builds: number;
  in_flight: number;
  created_at: string;
  updated_at: string;
}

const collect = (val: string, prev: string[]): string[] => [...prev, val];

/** A build pool by id or by name (pools have no slug). */
export async function resolveBuildPool(
  client: HttpClient,
  tenantId: string,
  idOrName: string,
): Promise<string> {
  if (isUuid(idOrName)) return idOrName;
  const res = await client.get<PaginatedResponse<BuildPool>>(
    `/tenants/${tenantId}/build-pools/?limit=${HARD_LIMIT}`,
  );
  const found = res.items.find((p) => p.name === idOrName);
  if (found) return found.id;
  const available = res.items.map((p) => p.name).join(", ");
  const e = new Error(
    `build pool '${idOrName}' not found${available ? `. available: ${available}` : ""}`,
  ) as Error & { exitCode: number };
  e.exitCode = EXIT.NOT_FOUND;
  throw e;
}

async function resolveServerIds(
  client: HttpClient,
  tenantId: string,
  refs: string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const ref of refs) ids.push(await resolveServer(client, tenantId, ref));
  return ids;
}

export function registerBuildPools(program: Command): void {
  const g = program.command("build-pools").description("manage build pools (groups of build servers)");

  g.command("ls")
    .description("list build pools")
    .option("--skip <n>", "pagination skip", "0")
    .option("--limit <n>", "pagination limit", "20")
    .action(async (opts: { skip: string; limit: string }) => {
      const fmt = resolveFormat(globalOutput(program));
      const skip = parseOffset(opts.skip);
      const limit = parseLimit(opts.limit, HARD_LIMIT);
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const res = await ctx.client.get<PaginatedResponse<BuildPool>>(
        `/tenants/${tid}/build-pools/?skip=${skip}&limit=${limit}`,
      );
      const rows = res.items.map((p) => ({ ...p, builders: p.server_ids.length }));
      printList(
        rows as unknown as Array<Record<string, unknown>>,
        [
          { key: "id", label: "ID" },
          { key: "name", label: "NAME" },
          { key: "mode", label: "MODE" },
          { key: "builders", label: "BUILDERS" },
          { key: "max_concurrent_builds", label: "MAX CONCURRENT" },
          { key: "in_flight", label: "IN FLIGHT" },
        ],
        fmt,
      );
    });

  g.command("get <idOrName>")
    .description("show one build pool")
    .action(async (idOrName: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const id = await resolveBuildPool(ctx.client, tid, idOrName);
      const pool = await ctx.client.get<BuildPool>(`/tenants/${tid}/build-pools/${id}`);
      printObject(pool as unknown as Record<string, unknown>, fmt);
    });

  withCompletion(
    g
      .command("create")
      .description("create a build pool from build or both servers")
      .requiredOption("--name <name>", "pool name")
      .option("--server <idOrSlug>", "build server to add (repeatable, at least one)", collect, [] as string[])
      .option("--max-concurrent <n>", "builds that may run at once (1-16, default 1)")
      .action(async (opts: { name: string; server: string[]; maxConcurrent?: string }) => {
        if (opts.server.length === 0) throw badUsage("at least one --server is required");
        const maxConcurrent =
          opts.maxConcurrent === undefined
            ? undefined
            : parseIntFlag(opts.maxConcurrent, "--max-concurrent", MAX_CONCURRENT_RANGE.min, MAX_CONCURRENT_RANGE.max);
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const body: Record<string, unknown> = {
          name: opts.name,
          mode: "persistent",
          server_ids: await resolveServerIds(ctx.client, tid, opts.server),
        };
        if (maxConcurrent !== undefined) body["max_concurrent_builds"] = maxConcurrent;
        const pool = await ctx.client.post<BuildPool>(`/tenants/${tid}/build-pools/`, body);
        printMutation(
          program,
          pool as unknown as Record<string, unknown>,
          `✓ build pool created: ${pool.name} (id: ${pool.id})`,
        );
      }),
    { flags: { "--server": "servers" } },
  );

  withCompletion(
    g
      .command("set <idOrName>")
      .description("update a build pool (--server replaces the whole builder list)")
      .option("--name <name>", "new name")
      .option("--server <idOrSlug>", "build server (repeatable; replaces the current list)", collect, [] as string[])
      .option("--max-concurrent <n>", "builds that may run at once (1-16)")
      .action(
        async (idOrName: string, opts: { name?: string; server: string[]; maxConcurrent?: string }) => {
          const maxConcurrent =
            opts.maxConcurrent === undefined
              ? undefined
              : parseIntFlag(opts.maxConcurrent, "--max-concurrent", MAX_CONCURRENT_RANGE.min, MAX_CONCURRENT_RANGE.max);
          if (opts.name === undefined && opts.server.length === 0 && maxConcurrent === undefined) {
            throw badUsage("no fields to update");
          }
          const ctx = await bootstrap();
          const tid = await requireTenantId(ctx);
          const id = await resolveBuildPool(ctx.client, tid, idOrName);
          const body: Record<string, unknown> = {};
          if (opts.name !== undefined) body["name"] = opts.name;
          if (opts.server.length > 0) body["server_ids"] = await resolveServerIds(ctx.client, tid, opts.server);
          if (maxConcurrent !== undefined) body["max_concurrent_builds"] = maxConcurrent;
          const pool = await ctx.client.patch<BuildPool>(`/tenants/${tid}/build-pools/${id}`, body);
          printMutation(
            program,
            pool as unknown as Record<string, unknown>,
            `✓ build pool updated: ${pool.name} (id: ${pool.id})`,
          );
        },
      ),
    { flags: { "--server": "servers" } },
  );

  g.command("rm <idOrName>")
    .description("delete a build pool")
    .option("--yes", "skip confirmation prompt")
    .action(async (idOrName: string, opts: { yes?: boolean }) => {
      if (!opts.yes) {
        const ok = await promptYesNo(`delete build pool ${idOrName}? [y/N]: `);
        if (!ok) {
          process.stderr.write("aborted (pass --yes to confirm non-interactively)\n");
          process.exit(1);
        }
      }
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const id = await resolveBuildPool(ctx.client, tid, idOrName);
      await ctx.client.del<void>(`/tenants/${tid}/build-pools/${id}`);
      process.stdout.write(`✓ build pool removed: ${idOrName}\n`);
    });
}
