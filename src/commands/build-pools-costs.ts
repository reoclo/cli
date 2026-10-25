// src/commands/build-pools-costs.ts
//
// Ephemeral pool cost commands: hourly estimates, month-to-date costs and
// budget, the builder ledger, and consumption-statement reconciliation.
import { readFileSync, statSync } from "node:fs";
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { EXIT } from "../client/exit-codes";
import type { HttpClient } from "../client/http";
import { isUuid } from "../client/resolve";
import type { PaginatedResponse } from "../client/types";
import { globalOutput, printList, printObject, resolveFormat } from "../ui/output";
import { budgetLevel, formatHourly, formatMinor, RATE_SCALE } from "../util/ephemeral-pool";
import { badUsage } from "../util/parse-flag";
import { parseLimit, parseOffset } from "../util/parse-limit";
import { resolveBuildPool } from "./build-pools";

const MAX_STATEMENT_BYTES = 1024 * 1024;

interface CloudCredential { id: string; label: string; provider: string; scope: string }
interface CostSummary {
  currency: string; net_minor_units: number; gross_minor_units: number | null;
  forecast_net_minor_units: number; forecast_gross_minor_units: number | null;
  builder_count: number; incomplete_builders: number;
}
interface CostReport { month: string; as_of: string; forecast_method: string; currencies: CostSummary[] }
interface Estimate {
  server_type: string; location: string; currency: string; price_source: string;
  hourly_net_scaled_minor_units: number; hourly_gross_scaled_minor_units: number | null;
  pricing_snapshot_id: string | null; pricing_snapshot_at?: string | null;
  server_hourly_net_scaled_minor_units?: number | null; ipv4_hourly_net_scaled_minor_units?: number | null;
}
interface Builder {
  id: string; state: string; server_type: string; location: string | null; provider_server_id: string | null;
  created_at: string; deleted_at: string | null; max_lifetime_minutes: number; error_code: string | null;
  cost: { currency: string; net_minor_units: number; billed_hours: number } | null;
}
interface Reconciliation {
  month: string; currency: string;
  matches: Array<{ provider_server_id: string; estimated_net_minor_units: number; statement_net_minor_units: number; net_difference_minor_units: number; estimate_incomplete: boolean }>;
  unmatched_lines: Array<{ row: number; provider_server_id: string; resource_type: string; currency: string; net_scaled_minor_units: number; reason: string }>;
}

export async function resolveCloudCredential(client: HttpClient, tenantId: string, idOrLabel: string): Promise<string> {
  if (isUuid(idOrLabel)) return idOrLabel;
  const all = await client.get<CloudCredential[]>(`/tenants/${tenantId}/cloud-credentials`);
  const found = all.find((c) => c.label === idOrLabel && c.provider === "hetzner");
  if (found) return found.id;
  const e = new Error(`hetzner credential '${idOrLabel}' not found`) as Error & { exitCode: number };
  e.exitCode = EXIT.NOT_FOUND;
  throw e;
}

function priceSource(e: Estimate): string {
  if (e.price_source === "hetzner_snapshot") {
    return `hetzner snapshot ${e.pricing_snapshot_id ?? ""}${e.pricing_snapshot_at ? ` from ${e.pricing_snapshot_at.slice(0, 10)}` : ""}`;
  }
  return e.price_source === "catalog_fallback" ? "reoclo plan catalog (no pricing sync yet)" : "built-in table from 2026-10-24 (no pricing sync yet)";
}

function ageMinutes(b: Builder, now: number): number {
  const end = b.deleted_at ? Date.parse(b.deleted_at) : now;
  return Math.max(0, Math.floor((end - Date.parse(b.created_at)) / 60_000));
}

export function builderWarning(b: Builder, now: number): string {
  if (b.state === "deleted") return "";
  if (b.state === "failed" || (b.state === "deleting" && b.error_code)) return "failed, deleting";
  return ageMinutes(b, now) > b.max_lifetime_minutes ? "past max lifetime" : "";
}

export function budgetNote(spent: number, budget: number): string {
  const level = budgetLevel(spent, budget);
  if (level === "exceeded") return "budget reached: new builders are paused";
  return level === "warning" ? "over 80% of the budget is used" : "";
}

export function registerBuildPoolCosts(g: Command, program: Command): void {
  g.command("estimate [pool]")
    .description("hourly cost of a new ephemeral builder (server plus IPv4), from a pool or from unsaved settings")
    .option("--server-type <type>", "server type (with a pool: one of its configured types)")
    .option("--cloud-credential <idOrLabel>", "without a pool: Hetzner credential")
    .option("--location <loc>", "without a pool: Hetzner location")
    .action(async (pool: string | undefined, opts: { serverType?: string; cloudCredential?: string; location?: string }) => {
      if (pool === undefined && (!opts.cloudCredential || !opts.location || !opts.serverType)) {
        throw badUsage("pass a pool, or --cloud-credential, --location and --server-type");
      }
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const params = new URLSearchParams();
      if (pool !== undefined) params.set("pool_id", await resolveBuildPool(ctx.client, tid, pool));
      else {
        params.set("cloud_credential_id", await resolveCloudCredential(ctx.client, tid, opts.cloudCredential ?? ""));
        params.set("location", opts.location ?? "");
      }
      if (opts.serverType) params.set("server_type", opts.serverType);
      const e = await ctx.client.get<Estimate>(`/tenants/${tid}/build-costs/estimate?${params}`);
      if (fmt !== "text") return printObject(e as unknown as Record<string, unknown>, fmt);
      printObject({
        server_type: e.server_type, location: e.location,
        hourly_net: formatHourly(e.hourly_net_scaled_minor_units, e.currency),
        hourly_gross: formatHourly(e.hourly_gross_scaled_minor_units, e.currency),
        server_net: formatHourly(e.server_hourly_net_scaled_minor_units, e.currency),
        ipv4_net: formatHourly(e.ipv4_hourly_net_scaled_minor_units, e.currency),
        prices: priceSource(e),
      }, fmt);
    });

  g.command("costs [pool]")
    .description("month-to-date and forecast ephemeral builder costs, with budget usage for a pool")
    .action(async (pool: string | undefined) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const id = pool === undefined ? undefined : await resolveBuildPool(ctx.client, tid, pool);
      const report = await ctx.client.get<CostReport>(`/tenants/${tid}/build-costs${id ? `?pool_id=${id}` : ""}`);
      const detail = id ? await ctx.client.get<{ monthly_budget_cents?: number | null; budget_currency?: string }>(`/tenants/${tid}/build-pools/${id}`) : null;
      const currency = detail?.budget_currency ?? "EUR";
      const budget = detail?.monthly_budget_cents ?? null;
      const spent = report.currencies.find((c) => c.currency === currency)?.net_minor_units ?? 0;
      const budgetInfo = budget === null ? null : {
        monthly_budget_cents: budget, currency, used_net_minor_units: spent,
        used_percent: budget > 0 ? Math.round((spent * 100) / budget) : 100, level: budgetLevel(spent, budget),
      };
      if (fmt !== "text") return printObject({ ...report, ...(budgetInfo ? { budget: budgetInfo } : {}) }, fmt);
      process.stdout.write(`${report.month} as of ${report.as_of} (net excludes VAT)\n`);
      printList(report.currencies.map((c) => ({
        currency: c.currency, mtd_net: formatMinor(c.net_minor_units, c.currency), mtd_gross: formatMinor(c.gross_minor_units, c.currency),
        forecast_net: formatMinor(c.forecast_net_minor_units, c.currency), forecast_gross: formatMinor(c.forecast_gross_minor_units, c.currency),
        builders: c.builder_count, incomplete: c.incomplete_builders,
      })), [
        { key: "currency", label: "CURRENCY" }, { key: "mtd_net", label: "MTD NET" }, { key: "mtd_gross", label: "MTD GROSS" },
        { key: "forecast_net", label: "FORECAST NET" }, { key: "forecast_gross", label: "FORECAST GROSS" },
        { key: "builders", label: "BUILDERS" }, { key: "incomplete", label: "INCOMPLETE" },
      ], fmt);
      if (budgetInfo) {
        const note = budgetNote(spent, budgetInfo.monthly_budget_cents);
        process.stdout.write(`budget: ${formatMinor(spent, currency)} of ${formatMinor(budgetInfo.monthly_budget_cents, currency)} (${budgetInfo.used_percent}%)${note ? `, ${note}` : ""}\n`);
        for (const other of report.currencies.filter((c) => c.currency !== currency)) {
          process.stdout.write(`note: ${other.currency} costs cannot count toward the ${currency} budget\n`);
        }
      }
    });

  g.command("builders <pool>")
    .description("ephemeral builders in a pool, with lifecycle state, billed hours and estimated cost")
    .option("--skip <n>", "pagination skip", "0")
    .option("--limit <n>", "pagination limit", "20")
    .action(async (pool: string, opts: { skip: string; limit: string }) => {
      const fmt = resolveFormat(globalOutput(program));
      const skip = parseOffset(opts.skip);
      const limit = parseLimit(opts.limit, 100);
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const id = await resolveBuildPool(ctx.client, tid, pool);
      const res = await ctx.client.get<PaginatedResponse<Builder>>(`/tenants/${tid}/build-pools/${id}/builders?skip=${skip}&limit=${limit}`);
      const now = Date.now();
      printList(res.items.map((b) => ({
        ...b, type: `${b.server_type}${b.location ? ` ${b.location}` : ""}`, age_minutes: ageMinutes(b, now),
        billed_hours: b.cost?.billed_hours ?? 0, estimated_net: b.cost ? formatMinor(b.cost.net_minor_units, b.cost.currency) : "-",
        warning: builderWarning(b, now),
      })) as unknown as Array<Record<string, unknown>>, [
        { key: "id", label: "ID" }, { key: "provider_server_id", label: "HETZNER ID" }, { key: "state", label: "STATE" },
        { key: "type", label: "TYPE" }, { key: "age_minutes", label: "AGE (MIN)" }, { key: "billed_hours", label: "BILLED HOURS" },
        { key: "estimated_net", label: "EST. NET" }, { key: "warning", label: "WARNING" },
      ], fmt);
    });

  g.command("reconcile")
    .description("compare a Hetzner consumption statement CSV with builder estimates (tenant admins)")
    .requiredOption("--file <path>", "statement CSV, UTF-8, at most 1 MiB")
    .requiredOption("--cloud-credential <idOrLabel>", "Hetzner credential the statement belongs to")
    .requiredOption("--month <yyyy-mm>", "statement month")
    .action(async (opts: { file: string; cloudCredential: string; month: string }) => {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(opts.month)) throw badUsage(`invalid --month: '${opts.month}' (expected YYYY-MM)`);
      if (statSync(opts.file).size > MAX_STATEMENT_BYTES) throw badUsage("statement exceeds 1 MiB");
      const data = new Blob([new Uint8Array(readFileSync(opts.file))]);
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const params = new URLSearchParams({ cloud_credential_id: await resolveCloudCredential(ctx.client, tid, opts.cloudCredential), month: opts.month });
      const r = await ctx.client.postRaw<Reconciliation>(`/tenants/${tid}/build-costs/reconciliations?${params}`, data, "text/csv");
      if (fmt !== "text") return printObject(r as unknown as Record<string, unknown>, fmt);
      process.stdout.write(`${r.month}: ${r.matches.length} matched, ${r.unmatched_lines.length} unmatched (difference = statement minus estimate)\n`);
      printList(r.matches.map((m) => ({
        server: m.provider_server_id, estimated: formatMinor(m.estimated_net_minor_units, r.currency),
        statement: formatMinor(m.statement_net_minor_units, r.currency),
        difference: `${m.net_difference_minor_units > 0 ? "+" : ""}${formatMinor(m.net_difference_minor_units, r.currency)}`,
        note: m.estimate_incomplete ? "estimate incomplete" : "",
      })), [
        { key: "server", label: "HETZNER ID" }, { key: "estimated", label: "ESTIMATED NET" }, { key: "statement", label: "STATEMENT NET" },
        { key: "difference", label: "DIFFERENCE" }, { key: "note", label: "NOTE" },
      ], fmt);
      if (r.unmatched_lines.length > 0) {
        process.stdout.write("\nunmatched lines\n");
        printList(r.unmatched_lines.map((l) => ({
          row: l.row, resource: l.provider_server_id, type: l.resource_type,
          net: formatMinor(Math.round(l.net_scaled_minor_units / RATE_SCALE), l.currency), reason: l.reason,
        })), [
          { key: "row", label: "ROW" }, { key: "resource", label: "RESOURCE" }, { key: "type", label: "TYPE" },
          { key: "net", label: "NET" }, { key: "reason", label: "REASON" },
        ], fmt);
      }
    });
}
