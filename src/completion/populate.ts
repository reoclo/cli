// src/completion/populate.ts
//
// Best-effort helpers for opportunistically populating the completion cache
// from data a command already fetched. These MUST NEVER throw — a cache write
// failure must not break the command that triggered it.

import { writeEnvKeys, writeSlice } from "./cache";
import { RESOURCE_REGISTRY } from "./registry";
import type { Entry, IndexKind } from "./types";

/** Map raw API objects to Entries, write the slice (best-effort), and return
 *  the Entries. Never throws — a failed write is silently swallowed. */
export function cacheList(kind: IndexKind, items: readonly unknown[]): Entry[] {
  const entries = items.map((it) =>
    RESOURCE_REGISTRY[kind].toEntry(it as Record<string, unknown>),
  );
  try {
    writeSlice(kind, entries);
  } catch {
    // opportunistic cache write — never break the caller
  }
  return entries;
}

/** Write an app's env-key slice (best-effort). Never throws. */
export function cacheEnvKeys(appId: string, keys: string[]): void {
  try {
    writeEnvKeys(appId, keys);
  } catch {
    // opportunistic cache write — never break the caller
  }
}
