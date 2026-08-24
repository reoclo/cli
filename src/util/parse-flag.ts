// src/util/parse-flag.ts
//
// Shared validation for option values that must be a boolean, one of a fixed
// set, or an integer in a range. All three throw the same exit-coded error as
// parse-limit.ts (exit 2 = bad usage) so a mistyped flag reads the same way
// everywhere.

function badUsage(message: string): Error & { exitCode: number } {
  const e = new Error(message) as Error & { exitCode: number };
  e.exitCode = 2;
  return e;
}

/** Accept the spellings a caller is likely to reach for, not just "true"/"false". */
export function parseBool(raw: string, flag: string): boolean {
  const v = raw.trim().toLowerCase();
  if (["true", "yes", "y", "1", "on"].includes(v)) return true;
  if (["false", "no", "n", "0", "off"].includes(v)) return false;
  throw badUsage(`invalid ${flag}: '${raw}' (expected true or false)`);
}

export function parseEnum<T extends string>(
  raw: string,
  allowed: readonly T[],
  flag: string,
): T {
  const v = raw.trim().toLowerCase() as T;
  if (allowed.includes(v)) return v;
  throw badUsage(`invalid ${flag}: '${raw}' (expected one of: ${allowed.join(", ")})`);
}

export function parseIntFlag(raw: string, flag: string, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw badUsage(`invalid ${flag}: '${raw}' (expected integer between ${min} and ${max})`);
  }
  return parsed;
}
