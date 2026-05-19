// src/util/time.ts
//
// Parse user-supplied time strings used by CLI filters (e.g. `audit ls --from
// 24h`). Accepts a small relative grammar (`<N>m|h|d`) and falls back to
// JavaScript Date parsing (covers ISO 8601 and bare `YYYY-MM-DD`).

const RELATIVE = /^(\d+)([mhd])$/;

/**
 * Parse a time spec into an absolute Date.
 *
 * Accepts:
 *   - `"30m"` / `"24h"` / `"7d"` — N minutes/hours/days back from now
 *   - ISO 8601 strings (e.g. `"2026-05-15T10:00:00Z"`)
 *   - bare dates (e.g. `"2026-05-15"`)
 *
 * Throws on anything else with a hint pointing at the supported forms.
 */
export function parseTimeSpec(input: string): Date {
  const rel = input.match(RELATIVE);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const ms = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return new Date(Date.now() - n * ms);
  }
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid time spec: '${input}' (try '24h', '7d', or ISO 8601)`);
  }
  return d;
}
