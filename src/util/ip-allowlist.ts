// src/util/ip-allowlist.ts
//
// Shared flag handling for IP allowlists, used by `domains add`,
// `domains access` and `proxy allowlist`. Pure functions: the commands fetch
// current state and send the result.

import { EXIT } from "../client/exit-codes";
import type { IpAllowlist } from "../client/types";

function misuse(message: string): Error & { exitCode: number } {
  const e = new Error(message) as Error & { exitCode: number };
  e.exitCode = EXIT.MISUSE;
  return e;
}

/** Collect a repeatable option into an array (commander reducer). */
export function collectAllow(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Flags that describe an allowlist. `cloudflare` is undefined when neither --cloudflare nor --no-cloudflare was given. */
export interface AllowFlags {
  allow?: string[] | undefined;
  cloudflare?: boolean | undefined;
}

export function hasAllowFlags(flags: AllowFlags): boolean {
  return (flags.allow?.length ?? 0) > 0 || flags.cloudflare !== undefined;
}

/**
 * The allowlist a create call sends: only the flags that were given, so a
 * call with neither flag omits the field and inherits.
 */
export function allowlistFromFlags(flags: AllowFlags): IpAllowlist | undefined {
  if (!hasAllowFlags(flags)) return undefined;
  return { cidrs: flags.allow ?? [], presets: flags.cloudflare === true ? ["cloudflare"] : [] };
}

/**
 * Apply --allow / --cloudflare / --no-cloudflare on top of the current
 * allowlist. --allow replaces the custom ranges; --cloudflare and
 * --no-cloudflare replace the preset. Whatever a flag leaves alone is kept.
 *
 * A merge that ends with nothing in either list would open the target to
 * everyone as a side effect of removing a rule, so it is refused; the caller
 * names the explicit way to open it.
 */
export function mergeAllowlist(
  current: IpAllowlist | null | undefined,
  flags: AllowFlags,
  openHint: string,
): IpAllowlist {
  const base: IpAllowlist = current ?? { cidrs: [], presets: [] };
  const cidrs = (flags.allow?.length ?? 0) > 0 ? (flags.allow ?? []) : base.cidrs;
  const presets: IpAllowlist["presets"] =
    flags.cloudflare === undefined ? base.presets : flags.cloudflare ? ["cloudflare"] : [];
  if (cidrs.length === 0 && presets.length === 0) {
    throw misuse(`this would leave no allowed ranges, which opens access to everyone. Use ${openHint} for that.`);
  }
  return { cidrs, presets };
}

/** "inherit", "open", or a summary such as "cloudflare+2" or "3 CIDR". "-" when the API did not report it. */
export function allowlistLabel(value: IpAllowlist | null | undefined): string {
  if (value === undefined) return "-";
  if (value === null) return "inherit";
  if (value.cidrs.length === 0 && value.presets.length === 0) return "open";
  if (value.presets.length === 0) return `${value.cidrs.length} CIDR`;
  const presets = value.presets.join("+");
  return value.cidrs.length === 0 ? presets : `${presets}+${value.cidrs.length}`;
}

/** Human-readable detail lines for `domains access` and `proxy allowlist` with no flags. */
export function allowlistLines(value: IpAllowlist | null | undefined): string[] {
  const lines = [`access: ${allowlistLabel(value)}`];
  if (value) {
    for (const p of value.presets) lines.push(`  preset: ${p}`);
    for (const c of value.cidrs) lines.push(`  allow:  ${c}`);
  }
  return lines;
}
