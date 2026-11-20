// src/agents/shared.ts

export type JsonObject = Record<string, unknown>;

/** The stdio server a coding agent is told to run. */
export interface StdioServer {
  readonly command: string;
  readonly args: readonly string[];
}

/** What a config file says about the registered server. */
export interface RegisteredServer {
  readonly command: string | null;
}

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertNever(value: never): never {
  throw new Error(`unhandled variant: ${String(value)}`);
}

export function splice(text: string, start: number, end: number, insert: string): string {
  return text.slice(0, start) + insert + text.slice(end);
}
