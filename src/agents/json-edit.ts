// src/agents/json-edit.ts
//
// Edits ~/.claude.json as text. The file is large, written by Claude Code and
// holds numbers JSON.parse would round, so only the reoclo member is touched and
// every other byte stays as it was.
import { isDeepStrictEqual } from "node:util";
import { ConfigFormatError } from "./errors";
import { isRecord, splice, type JsonObject, type RegisteredServer, type StdioServer } from "./shared";

interface Member {
  readonly key: string;
  readonly start: number;
  readonly valueStart: number;
  readonly valueEnd: number;
}

interface Span {
  readonly open: number;
  readonly close: number;
  readonly members: readonly Member[];
}

const WHITESPACE = " \t\r\n";

function skipWhitespace(text: string, from: number): number {
  let i = from;
  while (i < text.length && WHITESPACE.includes(text.charAt(i))) i++;
  return i;
}

function skipString(text: string, open: number): number {
  let i = open + 1;
  while (i < text.length && text.charAt(i) !== '"') i += text.charAt(i) === "\\" ? 2 : 1;
  return i + 1;
}

function skipValue(text: string, from: number): number {
  const first = text.charAt(from);
  if (first === '"') return skipString(text, from);
  let i = from;
  if (first === "{" || first === "[") {
    let depth = 0;
    while (i < text.length) {
      const c = text.charAt(i);
      if (c === '"') {
        i = skipString(text, i);
        continue;
      }
      if (c === "{" || c === "[") depth++;
      if (c === "}" || c === "]") depth--;
      i++;
      if (depth === 0) return i;
    }
    return i;
  }
  while (i < text.length && !`,}] ${WHITESPACE}`.includes(text.charAt(i))) i++;
  return i;
}

function scanObject(text: string, open: number): Span {
  const members: Member[] = [];
  let i = skipWhitespace(text, open + 1);
  while (text.charAt(i) !== "}") {
    const keyEnd = skipString(text, i);
    const key: unknown = JSON.parse(text.slice(i, keyEnd));
    const valueStart = skipWhitespace(text, skipWhitespace(text, keyEnd) + 1);
    const valueEnd = skipValue(text, valueStart);
    members.push({ key: String(key), start: i, valueStart, valueEnd });
    i = skipWhitespace(text, valueEnd);
    if (text.charAt(i) === ",") i = skipWhitespace(text, i + 1);
  }
  return { open, close: i, members };
}

function leadBefore(text: string, pos: number): string {
  let i = pos;
  while (i > 0 && WHITESPACE.includes(text.charAt(i - 1))) i--;
  return text.slice(i, pos);
}

const indentOf = (lead: string): string => lead.slice(lead.lastIndexOf("\n") + 1);

function lineIndent(text: string, pos: number): string {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, pos))?.[0] ?? "";
}

function render(value: unknown, indent: string, unit: string, pretty: boolean): string {
  return pretty ? JSON.stringify(value, null, unit).replaceAll("\n", `\n${indent}`) : JSON.stringify(value);
}

function detectUnit(text: string, root: Span): string {
  const first = root.members[0];
  const indent = first ? indentOf(leadBefore(text, first.start)) : "";
  return indent.trim() === "" && indent !== "" ? indent : "  ";
}

function setMember(text: string, span: Span, key: string, value: unknown, unit: string): string {
  const name = JSON.stringify(key);
  const existing = span.members.findLast((m) => m.key === key);
  if (existing) {
    const lead = leadBefore(text, existing.start);
    return splice(text, existing.valueStart, existing.valueEnd, render(value, indentOf(lead), unit, lead.includes("\n")));
  }
  const last = span.members.at(-1);
  if (last) {
    const lead = leadBefore(text, last.start);
    const colon = text.slice(skipString(text, last.start), last.valueStart);
    const member = `${name}${colon}${render(value, indentOf(lead), unit, lead.includes("\n"))}`;
    return splice(text, last.valueEnd, last.valueEnd, `,${lead}${member}`);
  }
  if (!text.includes("\n")) return splice(text, span.open + 1, span.close, `${name}:${JSON.stringify(value)}`);
  const closing = lineIndent(text, span.open);
  const inner = closing + unit;
  return splice(text, span.open + 1, span.close, `\n${inner}${name}: ${render(value, inner, unit, true)}\n${closing}`);
}

function removeMember(text: string, span: Span, key: string): string {
  const at = span.members.findLastIndex((m) => m.key === key);
  const member = span.members[at];
  if (!member) return text;
  const next = span.members[at + 1];
  if (next) return splice(text, member.start, next.start, "");
  const prev = span.members[at - 1];
  if (prev) return splice(text, prev.valueEnd, member.valueEnd, "");
  return splice(text, span.open + 1, span.close, "");
}

function parseObject(text: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    if (e instanceof SyntaxError) throw new ConfigFormatError("unparsable", e.message);
    throw e;
  }
  if (!isRecord(value)) throw new ConfigFormatError("unparsable", "the top level is not a JSON object");
  return value;
}

function verified(next: string, expected: JsonObject): string {
  if (!isDeepStrictEqual(parseObject(next), expected)) {
    throw new ConfigFormatError("unsupported", "the edit would change other settings, so it was not made");
  }
  return next;
}

const entryFor = (server: StdioServer): JsonObject => ({ type: "stdio", command: server.command, args: [...server.args] });

export function readJsonEntry(text: string, name: string): RegisteredServer | null {
  if (text.trim() === "") return null;
  const servers = parseObject(text)["mcpServers"];
  const entry = isRecord(servers) ? servers[name] : undefined;
  if (!isRecord(entry)) return null;
  return { command: typeof entry["command"] === "string" ? entry["command"] : null };
}

export function addJsonEntry(text: string | undefined, name: string, server: StdioServer): string {
  const entry = entryFor(server);
  if (text === undefined || text.trim() === "") {
    return `${JSON.stringify({ mcpServers: { [name]: entry } }, null, 2)}\n`;
  }
  const root = parseObject(text);
  const rootSpan = scanObject(text, text.indexOf("{"));
  const unit = detectUnit(text, rootSpan);
  const member = rootSpan.members.findLast((m) => m.key === "mcpServers");
  if (!member) {
    const next = setMember(text, rootSpan, "mcpServers", { [name]: entry }, unit);
    return verified(next, { ...root, mcpServers: { [name]: entry } });
  }
  const servers = root["mcpServers"];
  if (!isRecord(servers)) throw new ConfigFormatError("unsupported", "mcpServers is not an object");
  const current = servers[name];
  const merged = { ...(isRecord(current) ? current : {}), ...entry };
  const next = setMember(text, scanObject(text, member.valueStart), name, merged, unit);
  return verified(next, { ...root, mcpServers: { ...servers, [name]: merged } });
}

export function removeJsonEntry(text: string, name: string): string {
  const root = parseObject(text);
  const servers = root["mcpServers"];
  if (!isRecord(servers) || !Object.hasOwn(servers, name)) return text;
  const member = scanObject(text, text.indexOf("{")).members.findLast((m) => m.key === "mcpServers");
  if (!member) return text;
  const next = removeMember(text, scanObject(text, member.valueStart), name);
  const rest = Object.fromEntries(Object.entries(servers).filter(([key]) => key !== name));
  return verified(next, { ...root, mcpServers: rest });
}
