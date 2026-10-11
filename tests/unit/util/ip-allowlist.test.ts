import { describe, expect, test } from "bun:test";
import {
  allowlistFromFlags,
  allowlistLabel,
  allowlistLines,
  collectAllow,
  mergeAllowlist,
} from "../../../src/util/ip-allowlist";

function exitCodeOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { exitCode?: number }).exitCode;
  }
  return undefined;
}

describe("allowlistFromFlags", () => {
  test("omits the field when no flag is given", () => {
    expect(allowlistFromFlags({})).toBeUndefined();
    expect(allowlistFromFlags({ allow: [] })).toBeUndefined();
  });

  test("builds the object from the flags given", () => {
    expect(allowlistFromFlags({ allow: ["10.0.0.0/8", "1.2.3.4"] })).toEqual({
      cidrs: ["10.0.0.0/8", "1.2.3.4"],
      presets: [],
    });
    expect(allowlistFromFlags({ cloudflare: true })).toEqual({ cidrs: [], presets: ["cloudflare"] });
    expect(allowlistFromFlags({ allow: ["10.0.0.0/8"], cloudflare: true })).toEqual({
      cidrs: ["10.0.0.0/8"],
      presets: ["cloudflare"],
    });
  });
});

describe("mergeAllowlist", () => {
  const current = { cidrs: ["10.0.0.0/8"], presets: ["cloudflare" as const] };

  test("--allow replaces the custom ranges and keeps the preset", () => {
    expect(mergeAllowlist(current, { allow: ["192.0.2.0/24"] }, "--open")).toEqual({
      cidrs: ["192.0.2.0/24"],
      presets: ["cloudflare"],
    });
  });

  test("--no-cloudflare drops the preset and keeps the ranges", () => {
    expect(mergeAllowlist(current, { cloudflare: false }, "--open")).toEqual({
      cidrs: ["10.0.0.0/8"],
      presets: [],
    });
  });

  test("--cloudflare keeps the ranges", () => {
    expect(mergeAllowlist({ cidrs: ["10.0.0.0/8"], presets: [] }, { cloudflare: true }, "--open")).toEqual({
      cidrs: ["10.0.0.0/8"],
      presets: ["cloudflare"],
    });
  });

  test("starts from empty when inheriting", () => {
    expect(mergeAllowlist(null, { cloudflare: true }, "--open")).toEqual({ cidrs: [], presets: ["cloudflare"] });
    expect(mergeAllowlist(undefined, { allow: ["10.0.0.0/8"] }, "--open")).toEqual({
      cidrs: ["10.0.0.0/8"],
      presets: [],
    });
  });

  test("refuses a merge that would open access, exit 2", () => {
    expect(exitCodeOf(() => mergeAllowlist(null, { cloudflare: false }, "--open"))).toBe(2);
    expect(exitCodeOf(() => mergeAllowlist({ cidrs: [], presets: ["cloudflare"] }, { cloudflare: false }, "--open"))).toBe(2);
  });
});

describe("allowlistLabel", () => {
  test("inherit, open and summaries", () => {
    expect(allowlistLabel(undefined)).toBe("-");
    expect(allowlistLabel(null)).toBe("inherit");
    expect(allowlistLabel({ cidrs: [], presets: [] })).toBe("open");
    expect(allowlistLabel({ cidrs: [], presets: ["cloudflare"] })).toBe("cloudflare");
    expect(allowlistLabel({ cidrs: ["a", "b"], presets: ["cloudflare"] })).toBe("cloudflare+2");
    expect(allowlistLabel({ cidrs: ["a", "b", "c"], presets: [] })).toBe("3 CIDR");
  });

  test("allowlistLines lists presets and ranges", () => {
    expect(allowlistLines(null)).toEqual(["access: inherit"]);
    expect(allowlistLines({ cidrs: ["10.0.0.0/8"], presets: ["cloudflare"] })).toEqual([
      "access: cloudflare+1",
      "  preset: cloudflare",
      "  allow:  10.0.0.0/8",
    ]);
  });
});

test("collectAllow accumulates repeated values", () => {
  expect(collectAllow("b", collectAllow("a"))).toEqual(["a", "b"]);
});
