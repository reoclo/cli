// src/ui/output.ts
import type { Command } from "commander";
import { isTTY } from "./tty";

function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return "";
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(v);
}

function writeYamlField(key: string, value: unknown, indent: number): void {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) {
    process.stdout.write(`${pad}${key}:\n`);
    return;
  }
  if (Array.isArray(value) || (typeof value === "object" && Object.keys(value).length > 0)) {
    process.stdout.write(`${pad}${key}:\n`);
    writeYaml(value, indent + 1);
    return;
  }
  if (typeof value === "object") {
    // empty object
    process.stdout.write(`${pad}${key}: {}\n`);
    return;
  }
  process.stdout.write(`${pad}${key}: ${yamlScalar(value)}\n`);
}

function writeYaml(value: unknown, indent: number): void {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        process.stdout.write(`${pad}-\n`);
        for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
          writeYamlField(k, v, indent + 1);
        }
      } else {
        process.stdout.write(`${pad}- ${yamlScalar(item)}\n`);
      }
    }
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      writeYamlField(k, v, indent);
    }
    return;
  }
  // scalar at top level (rare)
  process.stdout.write(`${pad}${yamlScalar(value)}\n`);
}

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
      writeYaml(item, 0);
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
    writeYaml(obj, 0);
    return;
  }
  const w = Math.max(...Object.keys(obj).map((k) => k.length));
  for (const [k, v] of Object.entries(obj)) {
    let val: string;
    if (v == null) {
      val = "";
    } else if (typeof v === "object") {
      val = JSON.stringify(v);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      val = String(v);
    }
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
