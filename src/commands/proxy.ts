// src/commands/proxy.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveServer } from "../client/resolve";
import { withCompletion } from "../client/command-meta";
import { EXIT } from "../client/exit-codes";
import type { IpAllowlist, ServerProxyConfig } from "../client/types";
import { globalOutput, printMutation, printObject, resolveFormat } from "../ui/output";
import {
  allowlistLabel,
  allowlistLines,
  collectAllow,
  hasAllowFlags,
  mergeAllowlist,
  type AllowFlags,
} from "../util/ip-allowlist";

export interface AllowlistOptions extends AllowFlags {
  clear?: boolean | undefined;
}

export function assertAllowlistOptions(opts: AllowlistOptions): void {
  if (opts.clear && hasAllowFlags(opts)) {
    const e = new Error("--clear cannot be combined with --allow or --cloudflare") as Error & { exitCode: number };
    e.exitCode = EXIT.MISUSE;
    throw e;
  }
}

/**
 * The PUT body for `proxy allowlist`, or null when no flag asks for a change
 * (the command then shows the server default). --allow and --cloudflare merge
 * into the server's current default.
 */
export function allowlistPutBody(
  opts: AllowlistOptions,
  current: IpAllowlist | null | undefined,
): { ip_allowlist: IpAllowlist | null } | null {
  assertAllowlistOptions(opts);
  if (opts.clear) return { ip_allowlist: null };
  if (!hasAllowFlags(opts)) return null;
  return { ip_allowlist: mergeAllowlist(current, opts, "--clear") };
}

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

  withCompletion(
    g
      .command("allowlist <server>")
      .description("show or change the server's default IP allowlist (managed proxy only)")
      .option("--allow <cidr>", "allow this IP or CIDR range (repeatable; replaces the custom ranges)", collectAllow)
      .option("--cloudflare", "allow Cloudflare's edge ranges")
      .option("--no-cloudflare", "stop allowing Cloudflare's edge ranges")
      .option("--clear", "remove the default allowlist")
      .action(async (serverRef: string, opts: AllowlistOptions) => {
        assertAllowlistOptions(opts);
        const fmt = resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const sid = await resolveServer(ctx.client, tid, serverRef);
        const server = await ctx.client.get<{ proxy?: ServerProxyConfig | null }>(`/tenants/${tid}/servers/${sid}`);
        const current = server.proxy?.ip_allowlist;
        const body = allowlistPutBody(opts, current);
        if (body === null) {
          if (fmt === "json" || fmt === "yaml") {
            printObject({ server: serverRef, ip_allowlist: current ?? null }, fmt);
          } else {
            console.log(serverRef);
            for (const line of allowlistLines(current)) console.log(line);
          }
          return;
        }
        const res = await ctx.client.put<ServerProxyConfig>(`/tenants/${tid}/servers/${sid}/proxy/ip-allowlist`, body);
        const label = body.ip_allowlist === null ? "cleared" : allowlistLabel(res?.ip_allowlist ?? body.ip_allowlist);
        printMutation(
          program,
          (res ?? {}) as unknown as Record<string, unknown>,
          `\u2713 ${serverRef} default access: ${label}`,
        );
      }),
    { args: [{ slot: 0, resource: "servers" }] },
  );
}
