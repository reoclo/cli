// src/secrets/template.ts
//
// Pure, IO-free parser for op:// env-template files. Turns a raw .env-style
// text blob into typed lines (raw / literal / ref) that later stages
// (resolution, injection) consume without re-parsing.

import { EXIT } from "../client/exit-codes";

export interface OpRef {
  vault: string;
  item: string;
  field: string;
}

export type TemplateLine =
  | { kind: "raw"; raw: string }
  | { kind: "literal"; key: string; value: string; raw: string }
  | { kind: "ref"; key: string; ref: OpRef; quote: '"' | "'" | null; raw: string };

/** Bad template *input* — an authoring mistake, not a resolution failure. */
export class TemplateError extends Error {
  exitCode = EXIT.MISUSE;
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

/** A well-formed ref that could not be resolved against Reoclo. */
export class ResolutionError extends Error {
  exitCode = EXIT.RESOLUTION_FAILED;
  constructor(message: string) {
    super(message);
    this.name = "ResolutionError";
  }
}

/** Guard for reading a template file: refuse a missing path with a clean
 *  MISUSE(2) instead of letting `Bun.file(path).text()` reject with a raw
 *  ENOENT (generic exit 1). A mistyped path is authoring MISUSE. */
export function assertInputExists(exists: boolean, path: string): void {
  if (!exists) {
    throw new TemplateError(`template file not found: ${path}`);
  }
}

const OP_PREFIX = "op://";

export function parseOpRef(raw: string): OpRef | null {
  if (!raw.startsWith(OP_PREFIX)) return null;
  const parts = raw.slice(OP_PREFIX.length).split("/");
  if (parts.length !== 3) return null;
  const [vault, item, field] = parts;
  if (!vault || !item || !field) return null;
  return { vault, item, field };
}

export function opRefString(ref: OpRef): string {
  return `${OP_PREFIX}${ref.vault}/${ref.item}/${ref.field}`;
}

/** Strip ONE layer of matching surrounding quotes. */
function stripMatchingQuotes(v: string): { inner: string; quote: '"' | "'" | null } {
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return { inner: v.slice(1, -1), quote: v[0] };
  }
  return { inner: v, quote: null };
}

export function parseTemplate(text: string): TemplateLine[] {
  return text.split("\n").map((raw, i): TemplateLine => {
    const trimmed = raw.trimStart();
    if (trimmed === "" || trimmed.startsWith("#")) return { kind: "raw", raw };
    const eq = raw.indexOf("=");
    if (eq === -1) return { kind: "raw", raw };
    const key = raw.slice(0, eq).trim();
    const { inner, quote } = stripMatchingQuotes(raw.slice(eq + 1).trim());
    if (inner.startsWith(OP_PREFIX)) {
      const ref = parseOpRef(inner);
      if (!ref) {
        throw new TemplateError(
          `line ${i + 1}: not a valid op:// reference: ${inner} (need op://<vault>/<item>/<field>)`,
        );
      }
      return { kind: "ref", key, ref, quote, raw };
    }
    return { kind: "literal", key, value: inner, raw };
  });
}

export type ResolvedSecrets = Map<string, Record<string, string>>;

export function collectRefs(lines: TemplateLine[]): { projects: string[]; refs: OpRef[] } {
  const refs: OpRef[] = [];
  const projects = new Set<string>();
  for (const l of lines) {
    if (l.kind === "ref") {
      refs.push(l.ref);
      projects.add(l.ref.vault);
    }
  }
  return { projects: [...projects], refs };
}

export function lookup(resolved: ResolvedSecrets, ref: OpRef): string {
  const record = resolved.get(ref.vault);
  // Object.hasOwn (not `?.[field] === undefined`) so a field literally named
  // toString/constructor/valueOf/hasOwnProperty is treated as missing rather
  // than resolving to an inherited prototype member.
  if (!record || !Object.hasOwn(record, ref.field)) {
    throw new ResolutionError(`${opRefString(ref)} not found in project '${ref.vault}'`);
  }
  return record[ref.field] as string;
}

export function buildEnv(lines: TemplateLine[], resolved: ResolvedSecrets): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lines) {
    if (l.kind === "ref") out[l.key] = lookup(resolved, l.ref);
    else if (l.kind === "literal") out[l.key] = l.value;
  }
  return out;
}

export function renderInject(lines: TemplateLine[], resolved: ResolvedSecrets): string {
  return lines
    .map((l) => {
      if (l.kind !== "ref") return l.raw;
      const value = lookup(resolved, l.ref);
      // Function replacer so `$` in the value is inserted verbatim, and only the
      // op ref token is replaced — quotes and any surrounding text stay intact.
      return l.raw.replace(opRefString(l.ref), () => value);
    })
    .join("\n");
}
