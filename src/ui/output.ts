// src/ui/output.ts
import { isTTY } from "./tty";

export type OutputFormat = "text" | "json" | "yaml";

export function resolveFormat(flag?: string): OutputFormat {
  if (flag === "json" || flag === "yaml" || flag === "text") return flag;
  return isTTY() ? "text" : "json";
}

export function printList<T extends Record<string, unknown>>(
  items: T[],
  columns: Array<keyof T | { key: keyof T; label: string }>,
  fmt: OutputFormat,
): void {
  if (fmt === "json") {
    for (const item of items) process.stdout.write(JSON.stringify(item) + "\n");
    return;
  }
  if (fmt === "yaml") {
    for (const item of items) {
      process.stdout.write("---\n");
      for (const [k, v] of Object.entries(item)) process.stdout.write(`${k}: ${String(v)}\n`);
    }
    return;
  }
  // text: simple aligned table
  const cols = columns.map((c) =>
    typeof c === "object" ? c : { key: c, label: String(c).toUpperCase() },
  );
  const widths = cols.map((c) =>
    Math.max(c.label.length, ...items.map((i) => String(i[c.key] ?? "").length)),
  );
  process.stdout.write(
    cols.map((c, i) => c.label.padEnd(widths[i] ?? 0)).join("  ") + "\n",
  );
  for (const item of items) {
    process.stdout.write(
      cols.map((c, i) => String(item[c.key] ?? "").padEnd(widths[i] ?? 0)).join("  ") + "\n",
    );
  }
}

export function printObject(obj: Record<string, unknown>, fmt: OutputFormat): void {
  if (fmt === "json") {
    process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
    return;
  }
  if (fmt === "yaml") {
    for (const [k, v] of Object.entries(obj)) {
      process.stdout.write(`${k}: ${String(v)}\n`);
    }
    return;
  }
  const w = Math.max(...Object.keys(obj).map((k) => k.length));
  for (const [k, v] of Object.entries(obj)) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const val = v == null ? "" : String(v);
    process.stdout.write(`${k.padEnd(w)}  ${val}\n`);
  }
}
