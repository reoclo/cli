// src/util/parse-set.ts
//
// Parse `--set key=value` (with optional dot-paths) into a nested object.
// Used by `reoclo apps config set` for arbitrary config field updates.

function coerce(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

function setDeep(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i] as string;
    const next = cur[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      cur[segment] = {};
    }
    cur = cur[segment] as Record<string, unknown>;
  }
  cur[path[path.length - 1] as string] = value;
}

export function parseSetFlags(values: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const v of values) {
    const eq = v.indexOf("=");
    if (eq === -1) {
      throw new Error(`invalid --set value: '${v}' (expected key=value)`);
    }
    const key = v.slice(0, eq);
    const val = v.slice(eq + 1);
    const path = key.split(".");
    setDeep(out, path, coerce(val));
  }
  return out;
}
