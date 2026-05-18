// src/completion/cache.ts
//
// Read/write the local completion cache (`completion-cache.json`, version 3).
// Every read is defensive: a missing, corrupt, or wrong-version file is
// treated as empty. Writes are atomic (temp file + rename) so concurrent
// writers (background refresh, list commands, `warm`) never tear the file.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { cacheDir } from "../config/paths";
import { INDEX_KINDS, type Entry, type IndexKind } from "./types";

const CACHE_VERSION = 3;

interface ResourceSlice {
  ts: number;
  entries: Entry[];
}
interface EnvKeySlice {
  ts: number;
  keys: string[];
}
interface CompletionCache {
  version: number;
  resources: Record<IndexKind, ResourceSlice>;
  envKeys: Record<string, EnvKeySlice>;
}

function emptyCache(): CompletionCache {
  const resources = {} as Record<IndexKind, ResourceSlice>;
  for (const k of INDEX_KINDS) resources[k] = { ts: 0, entries: [] };
  return { version: CACHE_VERSION, resources, envKeys: {} };
}

function cachePath(): string {
  return join(cacheDir(), "completion-cache.json");
}

function readCache(): CompletionCache {
  try {
    const p = cachePath();
    if (!existsSync(p)) return emptyCache();
    const parsed = JSON.parse(readFileSync(p, "utf8")) as CompletionCache;
    if (parsed.version !== CACHE_VERSION) return emptyCache();
    // Backfill any missing slice so callers never hit `undefined`.
    const rawResources =
      parsed.resources && typeof parsed.resources === "object" ? parsed.resources : {};
    const base = emptyCache();
    return {
      version: CACHE_VERSION,
      resources: { ...base.resources, ...rawResources },
      envKeys: parsed.envKeys && typeof parsed.envKeys === "object" ? parsed.envKeys : {},
    };
  } catch {
    return emptyCache();
  }
}

function writeCache(c: CompletionCache): void {
  const dest = cachePath();
  const dir = dirname(dest);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `completion-cache.json.tmp.${process.pid}.${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, JSON.stringify(c), "utf8"); // compact — internal artifact, not user-facing
  renameSync(tmp, dest);
}

/** Replace one resource slice and stamp it with the current time. */
export function writeSlice(kind: IndexKind, entries: Entry[]): void {
  const c = readCache();
  c.resources[kind] = { ts: Date.now(), entries };
  writeCache(c);
}

/** Replace several resource slices at once (used by warm / background refresh). */
export function writeAllSlices(slices: Partial<Record<IndexKind, Entry[]>>): void {
  const c = readCache();
  const now = Date.now();
  for (const k of INDEX_KINDS) {
    const entries = slices[k];
    if (entries !== undefined) c.resources[k] = { ts: now, entries };
  }
  writeCache(c);
}

/** Replace one app's env-key slice. */
export function writeEnvKeys(appId: string, keys: string[]): void {
  const c = readCache();
  c.envKeys[appId] = { ts: Date.now(), keys };
  writeCache(c);
}

/** Candidate entries for a resource kind (offline, never throws). */
export function getSlice(kind: IndexKind): Entry[] {
  return readCache().resources[kind]?.entries ?? [];
}

/** Cached env-var keys for an app ([] if never listed). */
export function getEnvKeys(appId: string): string[] {
  return readCache().envKeys[appId]?.keys ?? [];
}

/** Age in ms of a resource slice; Infinity if never populated. */
export function sliceAge(kind: IndexKind): number {
  const ts = readCache().resources[kind]?.ts ?? 0;
  return ts === 0 ? Infinity : Date.now() - ts;
}
