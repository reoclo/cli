// src/util/parse-limit.ts
//
// Shared `--limit` validation: positive integer, clamped to a per-command
// hard cap. Used by `audit ls`, `logs search`, and any future paginated
// list commands. Tightened from the previous Number.isFinite check to
// Number.isInteger so floats like "1.5" are rejected.

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
