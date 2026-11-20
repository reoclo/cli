// src/agents/toml-edit.ts
//
// Edits ~/.codex/config.toml as lines, so comments, ordering and every other
// table stay as written. Bun's TOML parser validates the file before the edit
// and proves afterwards that nothing but the reoclo table changed.
import { isDeepStrictEqual } from "node:util";
import { ConfigFormatError } from "./errors";
import { isRecord, type JsonObject, type RegisteredServer, type StdioServer } from "./shared";

const HEADER = /^\s*\[\[?(.+?)\]\]?\s*(?:#.*)?$/;
const KEY_PART = /"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+)/g;
const TABLE = "mcp_servers";

function parseToml(text: string): JsonObject {
  let value: unknown;
  try {
    value = Bun.TOML.parse(text);
  } catch (e) {
    if (e instanceof Error) throw new ConfigFormatError("unparsable", e.message);
    throw e;
  }
  if (!isRecord(value)) throw new ConfigFormatError("unparsable", "the top level is not a TOML table");
  return value;
}

const splitLines = (text: string): string[] => text.split(/(?<=\n)/);
const isBlank = (line: string | undefined): boolean => (line ?? "").trim() === "";

function headerPath(line: string): string[] | null {
  const header = HEADER.exec(line.replace(/\r?\n$/, ""))?.[1];
  if (!header) return null;
  return [...header.matchAll(KEY_PART)].map((part) => part[1] ?? part[2] ?? part[3] ?? "");
}

const isOwnPath = (path: string[], name: string): boolean => path[0] === TABLE && path[1] === name;

function findTable(lines: readonly string[], name: string): number {
  return lines.findIndex((line) => {
    const path = headerPath(line);
    return path !== null && path.length === 2 && isOwnPath(path, name);
  });
}

function tableEnd(lines: readonly string[], table: number, subtablesOf?: string): number {
  for (let i = table + 1; i < lines.length; i++) {
    const path = headerPath(lines[i] ?? "");
    if (path !== null && !(subtablesOf !== undefined && isOwnPath(path, subtablesOf))) return i;
  }
  return lines.length;
}

function serversOf(root: JsonObject): JsonObject {
  const servers = root[TABLE];
  return isRecord(servers) ? servers : {};
}

function rejectInline(root: JsonObject, serverName: string): void {
  if (Object.hasOwn(serversOf(root), serverName)) {
    throw new ConfigFormatError("unsupported", `[${TABLE}.${serverName}] is written inline, which this command does not edit`);
  }
}

const bracketDepth = (line: string): number => line.split("[").length - line.split("]").length;

function setKey(body: string[], key: string, line: string, eol: string): void {
  const at = body.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
  if (at === -1) {
    body.unshift(`${line}${eol}`);
    return;
  }
  let span = 1;
  let depth = bracketDepth(body[at] ?? "");
  while (depth > 0 && at + span < body.length) depth += bracketDepth(body[at + span++] ?? "");
  body.splice(at, span, `${line}${eol}`);
}

function appendTable(source: string, block: readonly string[], eol: string): string {
  let out = source;
  if (out !== "" && !out.endsWith("\n")) out += eol;
  if (out !== "" && !/\n[ \t\r]*\n$/.test(out)) out += eol;
  return out + block.map((line) => `${line}${eol}`).join("");
}

function withoutEmptyServers(root: JsonObject): JsonObject {
  if (Object.keys(serversOf(root)).length > 0) return root;
  return Object.fromEntries(Object.entries(root).filter(([key]) => key !== TABLE));
}

function verified(next: string, expected: JsonObject): string {
  if (!isDeepStrictEqual(withoutEmptyServers(parseToml(next)), withoutEmptyServers(expected))) {
    throw new ConfigFormatError("unsupported", "the edit would change other settings, so it was not made");
  }
  return next;
}

export function readTomlEntry(text: string, serverName: string): RegisteredServer | null {
  const entry = serversOf(parseToml(text))[serverName];
  if (!isRecord(entry)) return null;
  return { command: typeof entry["command"] === "string" ? entry["command"] : null };
}

export function addTomlEntry(text: string | undefined, serverName: string, server: StdioServer): string {
  const source = text ?? "";
  const before = parseToml(source);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = splitLines(source);
  const table = findTable(lines, serverName);
  const command = `command = ${JSON.stringify(server.command)}`;
  const args = `args = ${JSON.stringify(server.args)}`;
  let next: string;
  if (table === -1) {
    rejectInline(before, serverName);
    next = appendTable(source, [`[${TABLE}.${serverName}]`, command, args], eol);
  } else {
    const end = tableEnd(lines, table);
    const body = lines.slice(table + 1, end);
    setKey(body, "args", args, eol);
    setKey(body, "command", command, eol);
    const header = lines[table] ?? "";
    next = [...lines.slice(0, table), header.endsWith("\n") ? header : `${header}${eol}`, ...body, ...lines.slice(end)].join("");
  }
  const servers = serversOf(before);
  const current = servers[serverName];
  const merged = { ...(isRecord(current) ? current : {}), command: server.command, args: [...server.args] };
  return verified(next, { ...before, [TABLE]: { ...servers, [serverName]: merged } });
}

export function removeTomlEntry(text: string, serverName: string): string {
  const before = parseToml(text);
  const lines = splitLines(text);
  const table = findTable(lines, serverName);
  if (table === -1) {
    rejectInline(before, serverName);
    return text;
  }
  const kept = [...lines.slice(0, table), ...lines.slice(tableEnd(lines, table, serverName))];
  if (table > 0 && isBlank(kept[table - 1]) && (table >= kept.length || isBlank(kept[table]))) kept.splice(table - 1, 1);
  const rest = Object.fromEntries(Object.entries(serversOf(before)).filter(([key]) => key !== serverName));
  return verified(kept.join(""), { ...before, [TABLE]: rest });
}
