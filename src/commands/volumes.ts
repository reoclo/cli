// src/commands/volumes.ts
//
// `reoclo volumes` — Docker volume lifecycle on a server (list, inspect,
// create, delete, prune). Volumes are live-query only: there is no local
// persistence, so every command hits the runtime volumes API directly.
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { requireCapability, withCompletion } from "../client/command-meta";
import { resolveServer } from "../client/resolve";
import { globalOutput, printList, printMutation, printObject, resolveFormat } from "../ui/output";
import { promptYesNo } from "../ui/prompt";

export interface VolumeInfo {
  name: string;
  driver: string;
  mountpoint: string;
  created_at: string | null;
  labels: Record<string, string>;
  in_use: boolean;
  used_by: string[];
  size_bytes: number | null;
  protected: boolean;
}

export interface VolumesListResponse {
  volumes: VolumeInfo[];
  partial_error: string | null;
}

export interface VolumeActionResponse {
  success: boolean;
  volume_name: string;
  message: string;
}

export interface VolumePruneResponse {
  removed: string[];
  skipped_protected: string[];
  reclaimed_bytes: number | null;
}

/** Accumulate a repeatable `KEY=VALUE` flag into a dict. Copied from
 *  containers.ts's collectKV — that helper is module-private there. */
function collectKV(value: string, prev: Record<string, string>): Record<string, string> {
  const eq = value.indexOf("=");
  if (eq < 0) throw new Error(`expected KEY=VALUE, got '${value}'`);
  return { ...prev, [value.slice(0, eq)]: value.slice(eq + 1) };
}

/** Humanize a byte count for the `ls` table. `null` (unknown size) renders
 *  as "-" rather than an empty or misleading "0B". */
export function formatBytes(n: number | null): string {
  if (n === null) return "-";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

/** A non-null `partial_error` means the listing itself failed server-side —
 *  surface it as an error, never silently render an empty/healthy list. */
export function assertListing(res: VolumesListResponse): VolumeInfo[] {
  if (res.partial_error !== null && res.partial_error !== undefined) {
    throw new Error(res.partial_error);
  }
  return res.volumes ?? [];
}

function volumeStatus(v: VolumeInfo): string {
  return v.in_use ? `in use (${v.used_by?.length ?? 0})` : "unused";
}

/** The date part of an ISO8601 `created_at`, or "-" when absent. */
function createdDatePart(createdAt: string | null): string {
  if (!createdAt) return "-";
  const t = createdAt.indexOf("T");
  return t >= 0 ? createdAt.slice(0, t) : createdAt;
}

export function registerVolumes(program: Command): void {
  const g = program
    .command("volumes")
    .description("manage Docker volumes on a server")
    .addHelpText(
      "after",
      `
Examples:
  $ reoclo volumes ls my-server
  $ reoclo volumes inspect my-server pgdata
  $ reoclo volumes create my-server pgdata --driver local --label team=platform
  $ reoclo volumes rm my-server pgdata
  $ reoclo volumes prune my-server
`,
    );

  const lsCmd = g
    .command("ls <server>")
    .description("list volumes on a server")
    .action(async (server: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const sid = await resolveServer(ctx.client, tid, server);
      const res = await ctx.client.get<VolumesListResponse>(
        `/tenants/${tid}/runtime/servers/${sid}/volumes`,
      );
      const volumes = assertListing(res);
      const rows = volumes.map((v) => ({
        name: v.name,
        driver: v.driver,
        size: formatBytes(v.size_bytes),
        created: createdDatePart(v.created_at),
        status: volumeStatus(v),
        protected: v.protected ? "yes" : "",
      }));
      printList(
        rows,
        [
          { key: "name", label: "NAME" },
          { key: "driver", label: "DRIVER" },
          { key: "size", label: "SIZE" },
          { key: "created", label: "CREATED" },
          { key: "status", label: "STATUS" },
          { key: "protected", label: "PROTECTED" },
        ],
        fmt,
      );
    });
  withCompletion(lsCmd, { args: [{ slot: 0, resource: "servers" }] });
  requireCapability(lsCmd, "volume:read");

  const inspectCmd = g
    .command("inspect <server> <name>")
    .description("inspect a single volume on a server")
    .action(async (server: string, name: string) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const sid = await resolveServer(ctx.client, tid, server);
      const res = await ctx.client.get<VolumeInfo>(
        `/tenants/${tid}/runtime/servers/${sid}/volumes/${name}`,
      );
      printObject(res as unknown as Record<string, unknown>, fmt);
    });
  withCompletion(inspectCmd, { args: [{ slot: 0, resource: "servers" }] });
  requireCapability(inspectCmd, "volume:read");

  const createCmd = g
    .command("create <server> <name>")
    .description("create a volume on a server")
    .option("--driver <driver>", "volume driver (default: docker's default, 'local')")
    .option("--label <kv>", "label KEY=VALUE (repeatable)", collectKV, {})
    .action(
      async (
        server: string,
        name: string,
        opts: { driver?: string; label: Record<string, string> },
      ) => {
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const sid = await resolveServer(ctx.client, tid, server);
        const body: Record<string, unknown> = { name };
        if (opts.driver) body.driver = opts.driver;
        if (Object.keys(opts.label).length > 0) body.labels = opts.label;
        const res = await ctx.client.post<VolumeActionResponse>(
          `/tenants/${tid}/runtime/servers/${sid}/volumes`,
          body,
        );
        printMutation(
          program,
          res as unknown as Record<string, unknown>,
          `✓ volume created: ${name}`,
        );
      },
    );
  withCompletion(createCmd, { args: [{ slot: 0, resource: "servers" }] });
  requireCapability(createCmd, "volume:write");

  const rmCmd = g
    .command("rm <server> <name>")
    .description("delete a volume")
    .option("--yes", "skip confirmation prompt")
    .action(async (server: string, name: string, opts: { yes?: boolean }) => {
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const sid = await resolveServer(ctx.client, tid, server);

      if (!opts.yes) {
        const ok = await promptYesNo(`Delete volume '${name}' and all data in it? [y/N] `);
        if (!ok) {
          process.stderr.write("aborted (pass --yes to skip this prompt)\n");
          const err = new Error("volume delete aborted") as Error & { exitCode: number };
          err.exitCode = 1;
          throw err;
        }
      }

      const res = await ctx.client.del<VolumeActionResponse>(
        `/tenants/${tid}/runtime/servers/${sid}/volumes/${name}`,
      );
      printMutation(
        program,
        res as unknown as Record<string, unknown>,
        `✓ volume deleted: ${name}`,
      );
    });
  withCompletion(rmCmd, { args: [{ slot: 0, resource: "servers" }] });
  requireCapability(rmCmd, "volume:write");

  const pruneCmd = g
    .command("prune <server>")
    .description("delete all unused volumes on a server (protected volumes are skipped)")
    .option("--yes", "skip confirmation prompt")
    .action(async (server: string, opts: { yes?: boolean }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const sid = await resolveServer(ctx.client, tid, server);

      if (!opts.yes) {
        const ok = await promptYesNo(
          `Delete all unused volumes on '${server}'? Protected platform volumes are skipped. [y/N] `,
        );
        if (!ok) {
          process.stderr.write("aborted (pass --yes to skip this prompt)\n");
          const err = new Error("volume prune aborted") as Error & { exitCode: number };
          err.exitCode = 1;
          throw err;
        }
      }

      const res = await ctx.client.post<VolumePruneResponse>(
        `/tenants/${tid}/runtime/servers/${sid}/volumes/prune`,
      );

      if (fmt === "json" || fmt === "yaml") {
        printObject(res as unknown as Record<string, unknown>, fmt);
        return;
      }
      const removed = res.removed ?? [];
      const reclaimed =
        res.reclaimed_bytes !== null && res.reclaimed_bytes !== undefined
          ? `, reclaimed ${formatBytes(res.reclaimed_bytes)}`
          : "";
      process.stdout.write(`✓ pruned ${removed.length} volume(s)${reclaimed}\n`);
      if (res.skipped_protected && res.skipped_protected.length > 0) {
        process.stdout.write(`  skipped (protected): ${res.skipped_protected.join(", ")}\n`);
      }
    });
  withCompletion(pruneCmd, { args: [{ slot: 0, resource: "servers" }] });
  requireCapability(pruneCmd, "volume:write");
}
