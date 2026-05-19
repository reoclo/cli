// src/ui/output.ts
import type { Command } from "commander";
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

/** Read the global `--output` flag off the root program. */
export function globalOutput(program: Command): string | undefined {
  const opts: Record<string, unknown> = program.opts();
  return typeof opts["output"] === "string" ? opts["output"] : undefined;
}

/**
 * Print the result of a mutating command. Under `-o json` / `-o yaml`, dumps
 * the response object via printObject. Otherwise writes the human-readable
 * text line (a `✓ ...` summary) to stdout.
 *
 * Use this in every mutating command's success path so format-flag handling
 * stays consistent.
 */
export function printMutation(
  program: Command,
  obj: Record<string, unknown>,
  textLine: string,
): void {
  const fmt = resolveFormat(globalOutput(program));
  if (fmt === "json" || fmt === "yaml") {
    printObject(obj, fmt);
    return;
  }
  process.stdout.write(textLine + "\n");
}
