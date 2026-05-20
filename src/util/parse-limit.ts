// src/util/parse-limit.ts
//
// Shared `--limit` and `--skip` validation. `parseLimit` requires a positive
// integer and clamps to a per-command hard cap. `parseOffset` requires a
// non-negative integer (0 is a valid starting offset for pagination).
// Number.isInteger rejects floats like "1.5".

export function parseLimit(raw: string, hardCap: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    const e = new Error(
      `invalid --limit: '${raw}' (expected positive integer)`,
    ) as Error & { exitCode: number };
    e.exitCode = 2;
    throw e;
  }
  return Math.min(parsed, hardCap);
}

export function parseOffset(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    const e = new Error(
      `invalid --skip: '${raw}' (expected non-negative integer)`,
    ) as Error & { exitCode: number };
    e.exitCode = 2;
    throw e;
  }
  return parsed;
}
