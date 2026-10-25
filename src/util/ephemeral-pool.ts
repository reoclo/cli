// src/util/ephemeral-pool.ts
//
// Flags, validation and money formatting for ephemeral (Hetzner) build pools.
// Amounts are integer currency minor units; hourly rates are millionths of a
// minor unit, because Hetzner prices are fractions of a cent.
import type { Command } from "commander";
import { badUsage, parseEnum, parseIntFlag } from "./parse-flag";

export const RATE_SCALE = 1_000_000;

const SERVER_TYPE = /^[a-z][a-z0-9-]{1,49}$/;
const LOCATION = /^[a-z0-9-]{1,50}$/;
const CURRENCY = /^[A-Z]{3}$/;

export interface EphemeralFlags {
  cloudCredential?: string;
  location?: string;
  serverType?: string;
  fallbackType: string[];
  arch?: string;
  snapshot?: string;
  stockImage?: string;
  maxServers?: string;
  idlePolicy?: string;
  maxLifetime?: string;
  cache?: string;
  budget?: string;
  budgetCurrency?: string;
}

const collect = (val: string, prev: string[]): string[] => [...prev, val];

export function addEphemeralOptions(cmd: Command): Command {
  return cmd
    .option("--cloud-credential <idOrLabel>", "ephemeral: tenant Hetzner credential")
    .option("--location <loc>", "ephemeral: Hetzner location, e.g. fsn1")
    .option("--server-type <type>", "ephemeral: Hetzner server type, e.g. cx33")
    .option("--fallback-type <type>", "ephemeral: fallback server type, in order (repeatable)", collect, [] as string[])
    .option("--arch <arch>", "ephemeral: amd64 or arm64 (default amd64)")
    .option("--snapshot <imageId>", "ephemeral: snapshot image id (falls back to the stock image)")
    .option("--stock-image <name>", "ephemeral: stock image (default ubuntu-24.04)")
    .option("--max-servers <n>", "ephemeral: builders that may exist at once (1-50, default 1)")
    .option("--idle-policy <policy>", "ephemeral: hour_aware (default), immediate or ttl:<minutes>")
    .option("--max-lifetime <minutes>", "ephemeral: delete a builder at this age (5-1440, default 120)")
    .option("--cache <mode>", "ephemeral: registry (default) or none")
    .option("--budget <amount>", "ephemeral: monthly net budget, e.g. 25 or 25.50")
    .option("--budget-currency <code>", "ephemeral: budget currency (default EUR)");
}

export function parseMoney(raw: string, flag: string): number {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!match) throw badUsage(`invalid ${flag}: '${raw}' (expected an amount like 25 or 25.50)`);
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

export function parseIdlePolicy(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (v === "hour_aware" || v === "immediate") return v;
  const ttl = /^ttl:(\d+)$/.exec(v);
  if (ttl) return `ttl:${parseIntFlag(ttl[1] ?? "", "--idle-policy ttl minutes", 1, 9999)}`;
  throw badUsage(`invalid --idle-policy: '${raw}' (expected hour_aware, immediate or ttl:<minutes>)`);
}

function matching(raw: string, pattern: RegExp, flag: string): string {
  if (!pattern.test(raw)) throw badUsage(`invalid ${flag}: '${raw}'`);
  return raw;
}

const EPHEMERAL_KEYS = [
  "cloudCredential", "location", "serverType", "arch", "snapshot", "stockImage", "maxServers",
  "idlePolicy", "maxLifetime", "cache", "budget", "budgetCurrency",
] as const satisfies ReadonlyArray<keyof EphemeralFlags>;

export function hasEphemeralFlags(f: EphemeralFlags): boolean {
  return f.fallbackType.length > 0 || EPHEMERAL_KEYS.some((key) => f[key] !== undefined);
}

export function ephemeralFields(f: EphemeralFlags): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (f.location !== undefined) body["location"] = matching(f.location, LOCATION, "--location");
  if (f.serverType !== undefined) body["server_type"] = matching(f.serverType, SERVER_TYPE, "--server-type");
  if (f.fallbackType.length > 0) {
    if (f.fallbackType.length > 10) throw badUsage("at most 10 --fallback-type values");
    body["fallback_server_types"] = f.fallbackType.map((t) => matching(t, SERVER_TYPE, "--fallback-type"));
  }
  if (f.arch !== undefined) body["arch"] = parseEnum(f.arch, ["amd64", "arm64"] as const, "--arch");
  if (f.snapshot !== undefined) body["image"] = matching(f.snapshot, /^\d+$/, "--snapshot");
  if (f.stockImage !== undefined) body["stock_image"] = matching(f.stockImage, /^[a-z0-9.-]{1,80}$/, "--stock-image");
  if (f.maxServers !== undefined) body["max_servers"] = parseIntFlag(f.maxServers, "--max-servers", 1, 50);
  if (f.idlePolicy !== undefined) body["idle_policy"] = parseIdlePolicy(f.idlePolicy);
  if (f.maxLifetime !== undefined) body["max_lifetime_minutes"] = parseIntFlag(f.maxLifetime, "--max-lifetime", 5, 1440);
  if (f.cache !== undefined) body["cache"] = parseEnum(f.cache, ["none", "registry"] as const, "--cache");
  if (f.budget !== undefined) body["monthly_budget_cents"] = parseMoney(f.budget, "--budget");
  if (f.budgetCurrency !== undefined) {
    body["budget_currency"] = matching(f.budgetCurrency.toUpperCase(), CURRENCY, "--budget-currency");
  }
  return body;
}

function fixed(amount: number, maxDigits: number): string {
  const text = amount.toFixed(maxDigits).replace(/0+$/, "");
  const [whole, frac = ""] = text.split(".");
  return `${whole}.${frac.padEnd(2, "0")}`;
}

export function formatMinor(minorUnits: number | null | undefined, currency: string): string {
  if (minorUnits === null || minorUnits === undefined) return "-";
  const sign = minorUnits < 0 ? "-" : "";
  return `${sign}${currency} ${(Math.abs(minorUnits) / 100).toFixed(2)}`;
}

export function formatHourly(scaled: number | null | undefined, currency: string): string {
  if (scaled === null || scaled === undefined) return "-";
  return `${currency} ${fixed(scaled / RATE_SCALE / 100, 6)}/h`;
}

export type BudgetLevel = "ok" | "warning" | "exceeded";

export function budgetLevel(spent: number, budget: number): BudgetLevel {
  if (budget <= 0 || spent >= budget) return "exceeded";
  return spent * 10 >= budget * 8 ? "warning" : "ok";
}
